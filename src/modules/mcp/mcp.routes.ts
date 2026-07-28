/**
 * Single external MCP endpoint — Streamable HTTP transport, stateless.
 *
 * Third-party agentic layers point their MCP client at `<base>/mcp` (no install). Every
 * POST is a self-contained JSON-RPC exchange: a fresh McpServer + transport is built,
 * handles the request, and is torn down when the socket closes. No sessions, no server
 * affinity — horizontally scalable.
 *
 * Auth is a single optional shared bearer key (`MCP_API_KEY`). Unset ⇒ the endpoint is
 * OPEN (dev/test). Set ⇒ callers must send `Authorization: Bearer <key>`. The check is
 * wired but dormant until the env var is set — no code change to turn it on.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { env } from '@/config/env.js';
import { fail } from '@/shared/http/envelope.js';
import { buildMcpServer } from './mcp.server.js';

const POST_ONLY = fail('method_not_allowed', 'MCP endpoint is POST-only (stateless)');

/**
 * Constant-time bearer check for `Authorization: Bearer <token>`. Compares SHA-256
 * digests so neither the comparison time nor the token length depends on the secret —
 * a plain `===` on the raw token is a timing side channel. Digests are always 32 bytes,
 * so timingSafeEqual never throws on a length mismatch. Returns false for a missing or
 * non-Bearer header.
 */
function bearerAuthorized(header: string | undefined, key: string): boolean {
  const prefix = 'Bearer ';
  if (!header || !header.startsWith(prefix)) return false;
  const presented = createHash('sha256').update(header.slice(prefix.length)).digest();
  const expected = createHash('sha256').update(key).digest();
  return timingSafeEqual(presented, expected);
}

const mcpRoutes: FastifyPluginAsyncZod = async (app) => {
  if (!env.MCP_API_KEY && env.NODE_ENV === 'production') {
    app.log.warn('MCP endpoint is OPEN (MCP_API_KEY unset) — anyone can call /mcp');
  }

  app.post('/', async (request, reply) => {
    if (env.MCP_API_KEY && !bearerAuthorized(request.headers.authorization, env.MCP_API_KEY)) {
      return reply
        .status(401)
        .header('WWW-Authenticate', 'Bearer realm="mcp", error="invalid_token"')
        .send(fail('unauthorized', 'Invalid or missing MCP API key'));
    }

    // Hand the raw socket to the MCP transport. Fastify has already parsed the JSON body,
    // so pass request.body as the pre-parsed third arg (the transport then skips its own
    // stream read). hijack() tells Fastify we own the response from here.
    reply.hijack();
    const server = buildMcpServer();
    // Empty options = stateless (no sessionIdGenerator → no session tracking). Written as
    // `{}` rather than `{ sessionIdGenerator: undefined }` because the project's
    // exactOptionalPropertyTypes rejects an explicit-undefined optional property.
    const transport = new StreamableHTTPServerTransport({});
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      // Cast: the SDK types Transport.onclose looser than exactOptionalPropertyTypes
      // allows; the concrete transport does implement Transport.
      await server.connect(transport as Transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      request.log.error({ err }, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error' },
            id: null,
          }),
        );
      }
    }
    return reply;
  });

  // Stateless server: no session-scoped GET SSE stream and no DELETE teardown.
  app.get('/', (_request, reply) => reply.status(405).send(POST_ONLY));
  app.delete('/', (_request, reply) => reply.status(405).send(POST_ONLY));
};

export default mcpRoutes;
