/**
 * Razorpay adapter — plain REST (no SDK dependency). Active only when the key
 * pair is set in env; every helper throws/short-circuits cleanly when inactive
 * so dev/test environments keep the mock gateway and stay network-free.
 *
 * Flow (two-phase checkout):
 *   1. Placement creates a Razorpay Order for the charged amount (createRazorpayOrder)
 *      and stamps its id on the pending payments row(s) (`gateway_order_id`).
 *   2. The app runs Razorpay Checkout with that order id + our key id.
 *   3. Capture lands via BOTH legs, idempotently:
 *      - client → POST /consumer/checkout/verify-payment (HMAC-signed triplet)
 *      - Razorpay → POST /webhooks/razorpay (payment.captured, HMAC over raw body)
 *
 * Refunds: real API call against the captured payment id. The registered
 * PaymentGateway adapter routes refunds here when active.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/config/env.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import type { PaymentGateway, RefundResult, SettlementEntry } from './gateway.js';

const API_BASE = 'https://api.razorpay.com/v1';

export function isRazorpayActive(): boolean {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

/** Publishable key id — safe to hand to the app for Checkout. */
export function razorpayKeyId(): string {
  return env.RAZORPAY_KEY_ID ?? '';
}

function authHeader(): string {
  return `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;
}

async function rzp<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  if (!isRazorpayActive()) {
    throw new AppError(503, ErrorCode.InternalError, 'Payment gateway is not configured');
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: authHeader(),
      'content-type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const desc =
      (json as { error?: { description?: string } }).error?.description ??
      `Razorpay ${res.status}`;
    throw new AppError(502, ErrorCode.PaymentFailed, `Razorpay: ${desc}`);
  }
  return json as T;
}

export type RazorpayOrder = { id: string; amount: number; currency: string; status: string };

/** Create a Razorpay Order (amount in paise) for the app's Checkout to pay against. */
export async function createRazorpayOrder(input: {
  amountPaise: number;
  receipt: string;
  notes?: Record<string, string>;
}): Promise<RazorpayOrder> {
  return rzp<RazorpayOrder>('/orders', {
    amount: input.amountPaise,
    currency: 'INR',
    receipt: input.receipt.slice(0, 40), // razorpay cap
    ...(input.notes ? { notes: input.notes } : {}),
  });
}

function safeEqualHex(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * Checkout success proof: HMAC-SHA256(`${orderId}|${paymentId}`, key_secret)
 * must equal the signature Razorpay handed the client.
 */
export function verifyCheckoutSignature(input: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  signature: string;
}): boolean {
  if (!env.RAZORPAY_KEY_SECRET) return false;
  const expected = createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${input.razorpayOrderId}|${input.razorpayPaymentId}`)
    .digest('hex');
  return safeEqualHex(expected, input.signature);
}

/**
 * Webhook proof: HMAC-SHA256(raw body, webhook_secret) === X-Razorpay-Signature.
 * When RAZORPAY_WEBHOOK_SECRET is unset (webhook not yet registered) verification
 * is SKIPPED with a warning — acceptable in dev, set the secret in prod.
 */
export function verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean {
  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    console.warn('[razorpay] RAZORPAY_WEBHOOK_SECRET unset — webhook signature NOT verified');
    return true;
  }
  const expected = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature);
}

/** Full/partial refund against a captured payment. Returns the razorpay refund id. */
export async function razorpayRefund(input: {
  paymentId: string;
  amountPaise: number;
  notes?: Record<string, string>;
}): Promise<{ id: string; status: string }> {
  return rzp<{ id: string; status: string }>(`/payments/${input.paymentId}/refund`, {
    amount: input.amountPaise,
    ...(input.notes ? { notes: input.notes } : {}),
  });
}

/** True when a stored gatewayRef is a real Razorpay payment id (refundable via API). */
export function isRazorpayPaymentRef(gatewayRef: string | null | undefined): boolean {
  return Boolean(gatewayRef && gatewayRef.startsWith('pay_'));
}

/**
 * PaymentGateway adapter. `capture` is not used by the two-phase flow (Checkout
 * auto-captures; we verify + record) — it exists to satisfy the interface for
 * any legacy caller and simply refuses.
 */
export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay';

  async capture(): Promise<never> {
    throw new AppError(
      501,
      ErrorCode.InternalError,
      'Razorpay uses client Checkout + verify/webhook — server-side capture is not part of the flow',
    );
  }

  async refund(input: {
    disbursementId: string;
    sourceGatewayRef: string;
    amountPaise: number;
    idempotencyKey: string;
  }): Promise<RefundResult> {
    try {
      // Group-child refs carry a '#n' allocation suffix — the real payment id precedes it.
      const paymentId = input.sourceGatewayRef.split('#')[0]!;
      const r = await razorpayRefund({
        paymentId,
        amountPaise: input.amountPaise,
        notes: { disbursementId: input.disbursementId },
      });
      return { status: 'succeeded', gatewayRef: r.id, settledAt: new Date() };
    } catch (err) {
      return {
        status: 'failed',
        failureCode: 'gateway_refund_failed',
        failureMessage: (err as Error).message,
      };
    }
  }

  parseSettlement(payload: string): SettlementEntry[] {
    // Same simple CSV contract as the mock (gateway_ref,amount_paise,tx_at[,currency]);
    // map Razorpay's settlement report to this shape when exporting.
    const lines = payload.trim().split(/\r?\n/);
    if (lines.length === 0) return [];
    const header = lines[0]!.toLowerCase().split(',').map((s) => s.trim());
    const idxRef = header.indexOf('gateway_ref');
    const idxAmt = header.indexOf('amount_paise');
    const idxAt = header.indexOf('tx_at');
    const idxCur = header.indexOf('currency');
    if (idxRef === -1 || idxAmt === -1 || idxAt === -1) {
      throw new Error('CSV requires header columns: gateway_ref, amount_paise, tx_at');
    }
    const entries: SettlementEntry[] = [];
    for (let i = 1; i < lines.length; i += 1) {
      const raw = lines[i]!.trim();
      if (!raw) continue;
      const cols = raw.split(',').map((s) => s.trim());
      const ref = cols[idxRef];
      const amt = Number(cols[idxAmt]);
      const at = new Date(cols[idxAt]!);
      if (!ref || !Number.isFinite(amt) || Number.isNaN(at.getTime())) {
        throw new Error(`CSV row ${i + 1} is malformed`);
      }
      entries.push({
        gatewayRef: ref,
        amountPaise: amt,
        currency: idxCur >= 0 && cols[idxCur] ? cols[idxCur]! : 'INR',
        txAt: at,
      });
    }
    return entries;
  }
}

export const razorpayGateway = new RazorpayGateway();
