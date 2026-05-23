import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

const KindEnum = z.enum(['query', 'complaint', 'dispute']);
const StatusEnum = z.enum(['open', 'requested_evidence', 'decided', 'escalated']);
const AwaitingEnum = z.enum(['admin', 'retailer', 'consumer', 'none']);
const DecisionEnum = z.enum(['refund', 'fresh_delivery', 'pickup', 'no_refund', 'split']);
const OpenerEnum = z.enum(['consumer', 'retailer', 'admin', 'system']);

export const ListIssuesQuery = z.object({
  storeId: z.string().optional(),
  status: StatusEnum.optional(),
  awaitingParty: AwaitingEnum.optional(),
  assignedAdminId: z.string().optional(),
  kind: KindEnum.optional(),
  olderThanDays: z.coerce.number().int().min(0).max(3650).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const CreateIssueBody = z
  .object({
    storeId: z.string().min(1),
    kind: KindEnum,
    orderId: z.string().optional(),
    returnId: z.string().optional(),
    openedByActorType: OpenerEnum,
    openedByActorId: z.string().min(1),
    subject: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(5000),
    evidence: z.array(z.string().url()).default([]),
  })
  .refine((v) => !!v.orderId || !!v.returnId, {
    message: 'At least one of orderId or returnId is required',
    path: ['orderId'],
  });

export const AddMessageBody = z.object({
  body: z.string().trim().min(1).max(5000),
  attachments: z.array(z.string().url()).default([]),
});

export const AssignBody = z.object({
  adminId: z.string().min(1),
  awaitingParty: AwaitingEnum.optional(),
});

export const RequestEvidenceBody = z.object({
  fromParty: z.enum(['retailer', 'consumer']),
  note: z.string().trim().min(1).max(500),
});

export const DecideBody = z.object({
  decision: DecisionEnum,
  decisionNote: z.string().trim().min(1).max(2000),
  adjustmentPaise: z.coerce.number().int().nonnegative().optional(),
  itemDecisions: z
    .array(
      z.object({
        orderItemId: z.string().min(1),
        decision: DecisionEnum,
        adjustmentPaise: z.coerce.number().int().nonnegative().optional(),
      }),
    )
    .optional(),
});

export const ChangeKindBody = z.object({ kind: KindEnum });

export const FlagPartyBody = z.object({
  party: z.enum(['consumer', 'retailer']),
  reason: z.string().trim().min(1).max(1000),
});

export const BulkCloseBody = z.object({
  olderThanDays: z.coerce.number().int().min(1).max(3650),
  noConsumerReplySinceDays: z.coerce.number().int().min(0).max(3650).optional(),
  kind: KindEnum.optional(),
});

export const EscalateBody = z.object({
  note: z.string().trim().min(1).max(2000),
});
