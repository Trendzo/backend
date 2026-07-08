/**
 * §15 — Payment gateway adapter interface. The codebase talks to whatever PSP via this
 * interface; only the adapter knows the wire format. When a real PG arrives, write an
 * implementation, register it in `getGateway()`, and the surrounding flows (capture,
 * refund disbursement, settlement reconciliation) stay untouched.
 *
 * Mock impl is the dev/test fallback; it produces deterministic predictable results
 * so smoke tests don't need network calls. It is selected when `env.PAYMENT_GATEWAY`
 * is unset or set to `'mock'`.
 */

export type CaptureInput = {
  paymentId: string;
  amountPaise: number;
  method: 'upi' | 'card' | 'cod' | 'wallet' | 'gift_card';
  idempotencyKey: string;
};

export type CaptureResult =
  | { status: 'succeeded'; gatewayRef: string; settledAt: Date }
  | { status: 'failed'; failureCode: string; failureMessage: string };

export type RefundInput = {
  disbursementId: string;
  /** Gateway ref of the source payment we're refunding against. */
  sourceGatewayRef: string;
  amountPaise: number;
  idempotencyKey: string;
};

export type RefundResult =
  | { status: 'succeeded'; gatewayRef: string; settledAt: Date }
  | { status: 'failed'; failureCode: string; failureMessage: string };

/**
 * Parsed line item from a settlement file. All adapters normalize to this shape;
 * the reconciler is unaware of CSV / JSON / XML / Excel.
 */
export type SettlementEntry = {
  gatewayRef: string;
  amountPaise: number;
  currency: string;
  txAt: Date;
  /** Raw extra fields (for forensic display); never relied upon for matching. */
  raw?: Record<string, unknown>;
};

export interface PaymentGateway {
  readonly name: string;
  capture(input: CaptureInput): Promise<CaptureResult>;
  refund(input: RefundInput): Promise<RefundResult>;
  /**
   * Parse a settlement file payload (UTF-8 string or Buffer) into normalized entries.
   * Throws on unparseable input — the admin upload route catches and returns 400.
   */
  parseSettlement(payload: string): SettlementEntry[];
}

/**
 * Dev/test gateway. Capture + refund both succeed deterministically; settlement parser
 * accepts a small CSV with header `gateway_ref,amount_paise,tx_at,currency` (currency
 * column optional, defaults to INR).
 */
class MockGateway implements PaymentGateway {
  readonly name = 'mock';

  async capture(input: CaptureInput): Promise<CaptureResult> {
    // Deterministic mock — every request succeeds. Real gateways return 'failed' too;
    // the failure path is exercised separately by tests that hand-write failed payments.
    return {
      status: 'succeeded',
      gatewayRef: `MOCK-CAP-${input.paymentId.slice(-12)}`,
      settledAt: new Date(),
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    return {
      status: 'succeeded',
      gatewayRef: `MOCK-RFD-${input.disbursementId.slice(-12)}`,
      settledAt: new Date(),
    };
  }

  parseSettlement(payload: string): SettlementEntry[] {
    const lines = payload.trim().split(/\r?\n/);
    if (lines.length === 0) return [];
    const header = lines[0]!.toLowerCase().split(',').map((s) => s.trim());
    const idxRef = header.indexOf('gateway_ref');
    const idxAmt = header.indexOf('amount_paise');
    const idxAt = header.indexOf('tx_at');
    const idxCur = header.indexOf('currency');
    if (idxRef === -1 || idxAmt === -1 || idxAt === -1) {
      throw new Error(
        'Mock CSV requires header columns: gateway_ref, amount_paise, tx_at (currency optional)',
      );
    }
    const entries: SettlementEntry[] = [];
    for (let i = 1; i < lines.length; i += 1) {
      const raw = lines[i]!.trim();
      if (!raw) continue;
      const cols = raw.split(',').map((s) => s.trim());
      const ref = cols[idxRef];
      const amt = Number(cols[idxAmt]);
      const at = new Date(cols[idxAt]!);
      const currency = idxCur >= 0 && cols[idxCur] ? cols[idxCur]! : 'INR';
      if (!ref || !Number.isFinite(amt) || Number.isNaN(at.getTime())) {
        throw new Error(`Mock CSV row ${i + 1} is malformed`);
      }
      entries.push({ gatewayRef: ref, amountPaise: amt, currency, txAt: at });
    }
    return entries;
  }
}

const mockGateway = new MockGateway();

// razorpay.ts only type-imports from this file, so the value import below is
// cycle-free at runtime.
import { isRazorpayActive, razorpayGateway } from './razorpay.js';

/**
 * Single source of truth for which gateway is active. Razorpay wins whenever its
 * key pair is configured (or when explicitly named); otherwise the mock keeps
 * dev/test flows network-free.
 */
export function getGateway(name?: string): PaymentGateway {
  if (name === 'razorpay' || (name === undefined && isRazorpayActive())) {
    return razorpayGateway;
  }
  return mockGateway;
}
