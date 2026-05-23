import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

const KindEnum = z.enum(['query', 'complaint', 'dispute']);
const StatusEnum = z.enum(['open', 'requested_evidence', 'decided', 'escalated']);
const AwaitingEnum = z.enum(['admin', 'retailer', 'consumer', 'none']);

export const ListIssuesQuery = z.object({
  status: StatusEnum.optional(),
  awaitingParty: AwaitingEnum.optional(),
  kind: KindEnum.optional(),
  orderId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const CreateIssueBody = z
  .object({
    kind: KindEnum,
    orderId: z.string().optional(),
    returnId: z.string().optional(),
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
