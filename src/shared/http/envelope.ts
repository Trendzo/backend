/**
 * Response envelope per BACKEND_SPEC §7: every response uses
 * `{ success: true, data: ... }` or `{ success: false, error: { code, message } }`.
 */

export type SuccessEnvelope<T> = {
  success: true;
  data: T;
};

export type ErrorEnvelope = {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export type ApiEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export const ok = <T>(data: T): SuccessEnvelope<T> => ({ success: true, data });

export const fail = (code: string, message: string, details?: unknown): ErrorEnvelope => ({
  success: false,
  error: { code, message, ...(details !== undefined && { details }) },
});
