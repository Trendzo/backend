import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

export const DisputeStatusEnum = z.enum([
  'open',
  'requested_evidence',
  'decided',
  'escalated',
]);
export const DisputeDecisionEnum = z.enum([
  'refund',
  'fresh_delivery',
  'pickup',
  'no_refund',
  'split',
]);
export const ActorTypeEnum = z.enum([
  'consumer',
  'retailer',
  'admin',
  'delivery_agent',
  'system',
]);

export const OpenDisputeBody = z
  .object({
    orderId: z.string().optional(),
    returnId: z.string().optional(),
    openedByActorType: ActorTypeEnum,
    openedByActorId: z.string().trim().min(1),
    description: z.string().trim().min(1).max(2000),
    evidence: z.array(z.string().url()).default([]),
  })
  .refine((v) => Boolean(v.orderId) !== Boolean(v.returnId), {
    message: 'Exactly one of orderId or returnId must be provided',
    path: ['orderId'],
  });

export const ListDisputesQuery = z.object({
  status: DisputeStatusEnum.optional(),
  orderId: z.string().optional(),
  returnId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const RequestEvidenceBody = z.object({
  note: z.string().trim().min(1).max(1000),
});

export const DecideBody = z.object({
  decision: DisputeDecisionEnum,
  decisionNote: z.string().trim().min(1).max(2000),
});

export const EscalateBody = z.preprocess(
  (v) => (v == null ? {} : v),
  z.object({ note: z.string().trim().max(1000).optional() }),
);
