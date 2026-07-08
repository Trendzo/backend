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
            if (r.settledOrderIds.length === 0) {
              // Late capture against rows we no longer hold pending (e.g. the
              // abandonment sweep cancelled the order) — recon owns it.
              console.error(
                `[razorpay-webhook] capture ${p.id} matched no pending rows (order ${p.order_id})`,
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
          // razorpay refund id). refund.failed flags it for the admin retry desk.
          const r = parsed.payload?.refund?.entity;
          if (r?.id) {
            if (parsed.event === 'refund.failed') {
              await db
                .update(refundDisbursements)
                .set({ status: 'failed' })
                .where(
                  and(
                    eq(refundDisbursements.gatewayRef, r.id),
                    like(refundDisbursements.gatewayRef, 'rfnd_%'),
                  ),
                );
            }
            // refund.processed: our row was already marked succeeded at creation.
          }
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
