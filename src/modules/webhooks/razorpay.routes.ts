/**
 * Razorpay webhook — the server-to-server source of truth for payment outcomes
 * (the client's verify-payment call is the fast path; this leg converges any
 * capture/failure the device dropped). Idempotent by construction: settle/fail
 * are flip-guarded, so replayed deliveries no-op.
 *
 * Signature: HMAC-SHA256 over the RAW request body with RAZORPAY_WEBHOOK_SECRET,
 * compared against X-Razorpay-Signature. This plugin therefore overrides the
 * JSON content-type parser (plugin-scoped — Fastify encapsulation keeps the rest
 * of the app on the normal parser) to receive the untouched buffer.
 *
 * Events handled:
 *   payment.captured  → settleGatewayCapture (flip pending→succeeded, confirm+route)
 *   payment.failed    → failGatewayCheckout  (flip pending→failed, order→payment_failed)
 *   refund.processed / refund.failed → annotate the matching refund disbursement
 * Everything else is acknowledged and ignored (200 — Razorpay retries non-2xx).
 */
import type { FastifyPluginAsync } from 'fastify';
import { and, eq, like } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { refundDisbursements } from '@/db/schema/index.js';
import { verifyWebhookSignature } from '@/shared/payments/razorpay.js';
import { notifyAllAdmins } from '@/shared/notify-admins.js';
import {
  failGatewayCheckout,
  settleGatewayCapture,
} from '@/shared/payments/settle-gateway.js';

type RzpWebhookPayload = {
  event: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        error_code?: string | null;
        error_description?: string | null;
      };
    };
    refund?: { entity?: { id?: string; payment_id?: string; status?: string } };
  };
};

const razorpayWebhookRoutes: FastifyPluginAsync = async (app) => {
  // Raw body for HMAC — scoped to this plugin only.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  app.post('/', async (req, reply) => {
    const raw = req.body as Buffer;
    const signature = req.headers['x-razorpay-signature'];
    if (typeof signature !== 'string' || !verifyWebhookSignature(raw, signature)) {
      return reply.status(400).send({ ok: false, error: 'bad signature' });
    }

    let parsed: RzpWebhookPayload;
    try {
      parsed = JSON.parse(raw.toString('utf8')) as RzpWebhookPayload;
    } catch {
      return reply.status(400).send({ ok: false, error: 'bad json' });
    }

    try {
      switch (parsed.event) {
        case 'payment.captured':
        case 'order.paid': {
          const p = parsed.payload?.payment?.entity;
          if (p?.order_id && p.id) {
            const r = await settleGatewayCapture(db, {
              gatewayOrderId: p.order_id,
              razorpayPaymentId: p.id,
            });
            if (r.orphans.length > 0) {
              // Captured money with nowhere to go (e.g. the abandonment sweep already
              // cancelled and refunded the order). recordOrphanCapture has already
              // logged it, alerted admins and — on a live gateway — pushed the money
              // back. This used to be a bare console.error and nothing else.
              console.error(
                `[razorpay-webhook] capture ${p.id} orphaned: ${r.orphans
                  .map((o) => `${o.paymentId}=${o.reason}`)
                  .join(', ')}`,
              );
            }
          }
          break;
        }
        case 'payment.failed': {
          const p = parsed.payload?.payment?.entity;
          if (p?.order_id) {
            await failGatewayCheckout(db, {
              gatewayOrderId: p.order_id,
              failureCode: p.error_code ?? 'payment_failed',
              ...(p.error_description ? { failureMessage: p.error_description } : {}),
            });
          }
          break;
        }
        case 'refund.processed':
        case 'refund.failed': {
          // Annotate the disbursement we created for this refund (gatewayRef =
          // razorpay refund id).
          const r = parsed.payload?.refund?.entity;
          if (r?.id && parsed.event === 'refund.failed') {
            /**
             * A refund Razorpay accepted and then failed asynchronously.
             *
             * This once flipped only the disbursement, leaving the parent refund at
             * 'succeeded' and telling nobody — so the customer kept reading "Refund
             * complete · back on your original payment method" for money that had
             * bounced. It now goes through the same force-fail path an admin would use,
             * which fails the leg, chains a retryable successor, and re-derives the
             * parent status from the legs.
             */
            // Backed by the partial unique on gateway_ref, so this is provably one row.
            const row = await db.query.refundDisbursements.findFirst({
              where: and(
                eq(refundDisbursements.gatewayRef, r.id),
                like(refundDisbursements.gatewayRef, 'rfnd_%'),
              ),
              columns: { id: true, refundId: true },
            });

            if (!row) {
              console.error(`[razorpay-webhook] refund.failed ${r.id} matched no disbursement`);
            } else {
              try {
                // Route through force-fail rather than flipping the row by hand: it
                // chains a fresh PENDING retry leg, so the admin retry desk can actually
                // act on it. The old hand-rolled flip left the leg 'failed' with no
                // successor, and retryDisbursement only accepts 'pending' — so a
                // webhook-failed refund was unretryable. Force-fail also 409s on an
                // already-failed leg, which makes a webhook replay a clean no-op: no
                // duplicate admin alert, and no stamping over an admin retry that
                // already reached 'succeeded'.
                const { forceFailDisbursement } = await import('@/shared/refunds/force-fail.js');
                await forceFailDisbursement(db, {
                  disbursementId: row.id,
                  reason: `razorpay refund.failed ${r.id}`,
                  actor: { type: 'system', id: 'razorpay-webhook' },
                });
                await notifyAllAdmins({
                  kind: 'system',
                  title: 'Gateway refund failed — needs retry',
                  body: `Refund ${row.refundId}: Razorpay reported refund ${r.id} as failed`,
                  payload: { refundId: row.refundId, disbursementId: row.id, gatewayRefundId: r.id },
                }).catch(() => undefined);
              } catch (err) {
                const code = (err as { code?: string }).code;
                if (code === 'disbursement_already_terminal') {
                  console.info(`[razorpay-webhook] refund.failed ${r.id} replay — already handled`);
                } else {
                  throw err;
                }
              }
            }
          }
          // refund.processed: our row was already marked succeeded at creation.
          break;
        }
        default:
          break; // acknowledged, ignored
      }
    } catch (err) {
      // Never bubble — Razorpay retries on non-2xx, and our handlers are
      // idempotent, but a hard 500 loop helps nobody. Log and 200.
      console.error(`[razorpay-webhook] ${parsed.event}: ${(err as Error).message}`);
    }

    return reply.send({ ok: true });
  });
};

export default razorpayWebhookRoutes;
