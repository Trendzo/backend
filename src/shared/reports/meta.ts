/**
 * §21 report metadata + CSV serializer.
 * Every report response gets generatedAt + IST string so the dashboard can render
 * "as of HH:MM IST". Optional CSV export via withCsv route wrapper.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface ReportMeta {
  generatedAt: string;
  generatedAtIst: string;
}

export function reportMeta(now: Date = new Date()): ReportMeta {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const iso = ist.toISOString();
  const friendly = `${iso.slice(0, 10)} ${iso.slice(11, 16)} IST`;
  return { generatedAt: now.toISOString(), generatedAtIst: friendly };
}

export interface ArrayReportEnvelope<T> {
  rows: T[];
  meta: ReportMeta;
}

export type ObjectReportEnvelope<T extends object> = T & { meta: ReportMeta };

export function withReportRows<T>(rows: T[]): ArrayReportEnvelope<T> {
  return { rows, meta: reportMeta() };
}

export function withReportMeta<T extends object>(payload: T): ObjectReportEnvelope<T> {
  return { ...payload, meta: reportMeta() };
}

/**
 * Polymorphic wrap: arrays → {rows, meta}, objects → {...payload, meta}.
 */
export function wrapReport<T>(payload: T): unknown {
  if (Array.isArray(payload)) return { rows: payload, meta: reportMeta() };
  if (payload && typeof payload === 'object') {
    return { ...(payload as object), meta: reportMeta() };
  }
  return { value: payload, meta: reportMeta() };
}

function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Flattens an array of records into CSV. For objects, serializes top-level entries
 * as 2-col rows. Strips a wrapping `{data: ...}` if present.
 */
export function toCsv(payload: unknown): string {
  const rows: unknown =
    payload && typeof payload === 'object' && 'data' in (payload as object)
      ? (payload as { data: unknown }).data
      : payload;
  if (Array.isArray(rows)) {
    if (rows.length === 0) return '';
    const keys = Array.from(
      rows.reduce<Set<string>>((acc, row) => {
        if (row && typeof row === 'object') {
          for (const k of Object.keys(row as object)) acc.add(k);
        }
        return acc;
      }, new Set()),
    );
    const header = keys.map(csvEscape).join(',');
    const body = rows
      .map((row) =>
        keys.map((k) => csvEscape((row as Record<string, unknown>)[k])).join(','),
      )
      .join('\n');
    return `${header}\n${body}`;
  }
  if (rows && typeof rows === 'object') {
    const entries = Object.entries(rows as Record<string, unknown>);
    const header = 'key,value';
    const body = entries.map(([k, v]) => `${csvEscape(k)},${csvEscape(v)}`).join('\n');
    return `${header}\n${body}`;
  }
  return String(rows ?? '');
}

/**
 * Wrap an async report handler so that `?format=csv` returns text/csv instead of JSON.
 * Handler must return the standard `{success, data}` envelope.
 */
export function withCsv<R>(
  handler: (req: FastifyRequest) => Promise<{ success: boolean; data: R }>,
  filename = 'report.csv',
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = await handler(req);
    const format = (req.query as { format?: string } | undefined)?.format;
    if (format === 'csv') {
      const data = payload.data as unknown;
      let csvSource: unknown = data;
      if (data && typeof data === 'object' && 'rows' in (data as Record<string, unknown>)) {
        csvSource = (data as Record<string, unknown>).rows;
      }
      void reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(toCsv(csvSource));
      return reply;
    }
    return payload;
  };
}
