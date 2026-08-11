import { Binary } from 'mongodb';
import type { FastifyRequest } from 'fastify';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { crm } from '../../db/client.js';
import { CRM_DOC_KINDS } from '../../domain.js';
import {
  assertCanSeeRetailer,
  CrmIdPrefix,
  crmId,
  getRetailerOr404,
  logActivity,
  nowIso,
  scopeFilter,
  touchRetailer,
  userNames,
  visibleUserIds,
  type CrmActor,
} from '../../store.js';
import { shapeDocument } from '../../shape.js';

/**
 * Field-collected documents: signed agreements, store photos, KYC scans.
 *
 * Bytes are stored inline as BSON Binary. At an 8 MB ceiling that sits comfortably inside
 * Mongo's 16 MB document limit and keeps the CRM a single self-contained datastore — no
 * bucket to provision, no signed-URL lifecycle, nothing to leak if the CRM is torn down.
 * Every listing query projects `data` away, so blobs only move on an explicit download.
 */

const MAX_BYTES = 8 * 1024 * 1024;

/** Only formats a field rep actually captures — camera roll, scans, or a PDF agreement. */
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);

export async function uploadDocument(input: {
  actor: CrmActor;
  id: string;
  req: FastifyRequest;
}) {
  const { actor, id, req } = input;
  const retailer = await getRetailerOr404(id);
  await assertCanSeeRetailer(actor, retailer);

  const file = await req.file();
  if (!file) {
    throw new AppError(
      400,
      ErrorCode.ValidationError,
      'No file in request — expected multipart/form-data with a `file` field',
    );
  }

  const rawKind = (file.fields as Record<string, unknown> | undefined)?.kind;
  const kind =
    rawKind && typeof rawKind === 'object' && 'value' in rawKind
      ? String((rawKind as { value: unknown }).value)
      : 'Other';
  if (!(CRM_DOC_KINDS as readonly string[]).includes(kind)) {
    throw new AppError(400, ErrorCode.ValidationError, 'Unknown document type');
  }

  const buffer = await file.toBuffer();
  if (buffer.byteLength === 0) {
    throw new AppError(400, ErrorCode.ValidationError, 'That file is empty');
  }
  if (buffer.byteLength > MAX_BYTES) {
    throw new AppError(413, ErrorCode.ValidationError, 'File is larger than 8 MB');
  }
  const mime = file.mimetype || 'application/octet-stream';
  if (!ALLOWED_MIME.has(mime)) {
    throw new AppError(
      415,
      ErrorCode.ValidationError,
      'Only images and PDF documents can be uploaded',
    );
  }

  const documents = await crm.documents();
  const at = nowIso();
  const docId = crmId(CrmIdPrefix.Document);
  await documents.insertOne({
    _id: docId,
    retailerId: id,
    userId: actor.kind === 'sales' ? actor.id : (retailer.assignedTo ?? ''),
    kind,
    filename: (file.filename || 'upload').slice(0, 200),
    mime,
    size: buffer.byteLength,
    data: new Binary(buffer),
    at,
  });

  await touchRetailer(id);
  await logActivity({ retailerId: id, actor, type: 'doc_uploaded', detail: `Uploaded ${kind}`, at });
  return ok({ id: docId });
}

/** Metadata + bytes for one document, after the same scoping the lead itself enforces. */
export async function getDocument(input: { actor: CrmActor; id: string }) {
  const documents = await crm.documents();
  const doc = await documents.findOne({ _id: input.id });
  if (!doc) throw new AppError(404, ErrorCode.NotFound, 'Document not found');
  const retailer = await getRetailerOr404(doc.retailerId);
  await assertCanSeeRetailer(input.actor, retailer);
  return {
    mime: doc.mime,
    // Strip quotes and CR/LF so the value can't break out of the Content-Disposition header.
    filename: doc.filename.replace(/["\r\n]/g, ''),
    buffer: Buffer.from(doc.data.buffer),
  };
}

/** Directory of every document the actor may see — powers the admin documents view. */
export async function listDocuments(input: { actor: CrmActor; retailerId?: string | undefined }) {
  const documents = await crm.documents();
  const visible = await visibleUserIds(input.actor);
  const filter: Record<string, unknown> = { ...scopeFilter(visible, 'userId') };
  if (input.retailerId) filter.retailerId = input.retailerId;

  const rows = await documents
    .find(filter, { projection: { data: 0 } })
    .sort({ at: -1 })
    .limit(500)
    .toArray();

  const retailers = await crm.retailers();
  const leads = await retailers
    .find(
      { _id: { $in: [...new Set(rows.map((r) => r.retailerId))] } },
      { projection: { storeName: 1, area: 1 } },
    )
    .toArray();
  const leadOf = new Map(leads.map((l) => [l._id, l]));
  const names = await userNames(rows.map((r) => r.userId));

  return ok({
    documents: rows.map((d) => ({
      ...shapeDocument(d, names.get(d.userId) ?? null),
      store_name: leadOf.get(d.retailerId)?.storeName ?? null,
      area: leadOf.get(d.retailerId)?.area ?? null,
    })),
  });
}
