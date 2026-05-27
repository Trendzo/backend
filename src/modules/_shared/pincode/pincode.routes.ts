import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import https from 'node:https';
import { z } from 'zod/v4';
import { ok } from '@/shared/http/envelope.js';

const PinParam = z.object({ pin: z.string().regex(/^\d{6}$/) });

type PostOffice = {
  Name: string;
  District: string;
  State: string;
  Country: string;
  Pincode: string;
};

type ApiResponse = {
  Message: string;
  Status: 'Success' | 'Error' | '404';
  PostOffice: PostOffice[] | null;
};

// postalpincode.in has an expired SSL cert — skip verification for this one upstream call only
function fetchPincode(pin: string): Promise<ApiResponse[]> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://api.postalpincode.in/pincode/${pin}`,
      { rejectUnauthorized: false, timeout: 5_000 },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          try { resolve(JSON.parse(body) as ApiResponse[]); }
          catch { reject(new Error('Invalid JSON from upstream')); }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Upstream timeout')); });
  });
}

const pincodeRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/:pin',
    { schema: { params: PinParam } },
    async (req, reply) => {
      const { pin } = req.params as z.infer<typeof PinParam>;

      let data: ApiResponse[];
      try {
        data = await fetchPincode(pin);
      } catch {
        return reply.status(502).send(ok(null));
      }

      const first = data[0];
      if (!first || first.Status !== 'Success' || !first.PostOffice?.length) {
        return ok(null);
      }

      const po = first.PostOffice[0]!;
      return ok({
        city: po.District,
        state: po.State,
        country: po.Country,
      });
    },
  );
};

export default pincodeRoutes;
