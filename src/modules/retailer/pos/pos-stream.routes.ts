import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { db } from '@/db/client.js';
import { retailerAccounts } from '@/db/schema/index.js';
import { verifyAccessToken } from '@/shared/auth/jwt.js';
import * as scanBus from '@/shared/pos/scan-bus.js';

/**
 * SSE stream for the QR-scan → register feature. Kept in its own plugin (mounted separately in
 * app.ts) so it does NOT inherit pos.routes' header-only `requireAuth` — browser `EventSource`
 * cannot set an `Authorization` header, so the web portal passes the bearer token as `?token=`.
 *
 * A web Register page opens `GET /retailer/pos/scan/stream?token=&registerId=&label=` and stays
 * connected; the mobile app's `POST /retailer/pos/scan` fans a scanned row here via the scan bus.
 */
const retailerPosStreamRoutes: FastifyPluginAsync = async (app) => {
  app.get('/scan/stream', async (req, reply) => {
    const { token, registerId, label } = req.query as {
      token?: string;
      registerId?: string;
      label?: string;
    };

    // Authenticate from the query token (EventSource can't send headers).
    if (!token) return reply.code(401).send({ success: false, error: { code: 'unauthorized', message: 'Missing token' } });
    let sub: string;
    try {
      const payload = verifyAccessToken(token);
      if (payload.kind !== 'retailer') {
        return reply.code(403).send({ success: false, error: { code: 'forbidden', message: 'Retailer token required' } });
      }
      sub = payload.sub;
    } catch {
      return reply.code(401).send({ success: false, error: { code: 'unauthorized', message: 'Invalid or expired token' } });
    }

    const account = await db.query.retailerAccounts.findFirst({
      where: eq(retailerAccounts.id, sub),
      columns: { storeId: true },
    });
    if (!account?.storeId) {
      return reply.code(404).send({ success: false, error: { code: 'not_found', message: 'Store not found' } });
    }
    const storeId = account.storeId;
    const sessionId = (registerId && registerId.trim()) || randomUUID();
    const sessionLabel = (label && label.trim() ? label.trim() : 'Register').slice(0, 120);

    // Take over the socket — bypass the JSON envelope/serializer and stream raw SSE.
    reply.hijack();
    const raw = reply.raw;
    const origin = req.headers.origin;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable proxy buffering (nginx) so events flush immediately.
      'X-Accel-Buffering': 'no',
      // @fastify/cors hooks are skipped once hijacked — set CORS manually for the
      // cross-origin portal (Vercel → backend).
      ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {}),
    });

    const write = (row: unknown) => {
      raw.write(`data: ${JSON.stringify(row)}\n\n`);
    };
    scanBus.register({ id: sessionId, label: sessionLabel, storeId, connectedAt: Date.now(), write });

    // Let the client learn its own session identity.
    raw.write(`event: ready\ndata: ${JSON.stringify({ sessionId, label: sessionLabel })}\n\n`);

    // Keep-alive comment so idle connections don't get reaped by proxies.
    const heartbeat = setInterval(() => {
      try {
        raw.write(': ping\n\n');
      } catch {
        /* socket gone — cleanup handler will fire */
      }
    }, 25000);

    const cleanup = () => {
      clearInterval(heartbeat);
      scanBus.unregister(storeId, sessionId);
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });
};

export default retailerPosStreamRoutes;
