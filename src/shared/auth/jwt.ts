import jwt from 'jsonwebtoken';
import { env } from '@/config/env.js';

/**
 * Three completely separate identity domains. The token's `kind` field is the discriminator;
 * middleware that protects a route asserts the expected kind so an admin token can't be used
 * on a retailer route (and vice versa) even though the underlying signing secret is shared.
 */
export type TokenKind = 'admin' | 'retailer' | 'consumer';

export type AccessTokenPayload = {
  sub: string; // account id
  kind: TokenKind;
  // kept loose so each domain can attach role info as needed
  subRole?: string;
};

type DecodedAccessTokenPayload = AccessTokenPayload & {
  iat: number;
  exp: number;
};

export function signAccessToken(payload: AccessTokenPayload): string {
  // jsonwebtoken accepts ms-style strings ('15m', '7d') at runtime; the strict TS overload
  // narrows to a literal union that env vars can't hit, so cast through unknown.
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as unknown as number,
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
