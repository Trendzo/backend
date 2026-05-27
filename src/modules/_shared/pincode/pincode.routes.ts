import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
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

const pincodeRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/:pin',
    { schema: { params: PinParam } },
    async (req, reply) => {
      const { pin } = req.params as z.infer<typeof PinParam>;

      let res: Response;
      try {
        res = await fetch(`https://api.postalpincode.in/pincode/${pin}`, {
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        return reply.status(502).send(ok(null));
      }

      if (!res.ok) return reply.status(502).send(ok(null));

      const data = (await res.json()) as ApiResponse[];
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
