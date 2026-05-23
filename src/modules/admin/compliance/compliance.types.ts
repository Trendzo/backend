import type { db } from '@/db/client.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';

export type Auth = AccessTokenPayload;

export type RawCycle = NonNullable<
  Awaited<ReturnType<typeof db.query.kycReverifications.findFirst>>
> & {
  documents: Array<{
    id: string;
    kind: string;
    url: string | null;
    status: string;
    uploadedAt: Date | null;
  }>;
};
