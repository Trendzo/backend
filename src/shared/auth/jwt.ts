import jwt from 'jsonwebtoken';
import { env } from '@/config/env.js';

/**
 * Three completely separate identity domains. The token's `kind` field is the discriminator;
 * middleware that protects a route asserts the expected kind so an admin token can't be used
 * on a retailer route (and vice versa) even though the underlying signing secret is shared.
 */
export type TokenKind = 'admin' | 'retailer' | 'consumer' | 'driver';

export type AccessTokenPayload = {
  sub: string;
  kind: TokenKind;
  subRole?: string | undefined;
  // Legacy field — kept for back-compat on any unrotated admin tokens that still
  // carry it. New impersonation tokens are issued as `kind: 'retailer'` with
  // `impersonator` set so retailer routes accept them transparently.
  impersonating?: { storeId: string; sessionId: string } | undefined;
  // Set on retailer-kind impersonation tokens — identifies the originating admin
  // so per-action audit logs can attribute the actor correctly.
  impersonator?: { adminId: string; sessionId: string } | undefined;
};

type DecodedAccessTokenPayload = AccessTokenPayload & {
  iat: number;
  exp: number;
};

export function signAccessToken(
  payload: AccessTokenPayload,
  opts?: { expiresIn?: string },
): string {
  // jsonwebtoken accepts ms-style strings ('15m', '7d') at runtime; the strict TS overload
  // narrows to a literal union that env vars can't hit, so cast through unknown.
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: (opts?.expiresIn ?? env.JWT_ACCESS_EXPIRES_IN) as unknown as number,
  });
}

export function verifyAccessToken(token: string): DecodedAccessTokenPayload {
  // Will throw a JsonWebTokenError / TokenExpiredError on bad input — caller turns it into AppError.
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
  if (typeof decoded === 'string') {
    throw new Error('jwt payload was a string');
  }
  return decoded as DecodedAccessTokenPayload;
}
