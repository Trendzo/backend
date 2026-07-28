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

/**
 * GST state codes (the first two digits of a GSTIN), keyed by the state name
 * postalpincode.in returns.
 *
 * The consumer address form needs this: `stateCode` is a required, 2-character
 * field on every address and it drives place-of-supply — whether an order is
 * taxed CGST+SGST (intra-state) or IGST (inter-state). Without it the app was
 * asking customers to type a two-letter code they have no way to know, or
 * defaulting it wrongly.
 */
const GST_STATE_CODES: Record<string, string> = {
  'Jammu and Kashmir': '01', 'Himachal Pradesh': '02', 'Punjab': '03',
  'Chandigarh': '04', 'Uttarakhand': '05', 'Haryana': '06', 'Delhi': '07',
  'Rajasthan': '08', 'Uttar Pradesh': '09', 'Bihar': '10', 'Sikkim': '11',
  'Arunachal Pradesh': '12', 'Nagaland': '13', 'Manipur': '14', 'Mizoram': '15',
  'Tripura': '16', 'Meghalaya': '17', 'Assam': '18', 'West Bengal': '19',
  'Jharkhand': '20', 'Odisha': '21', 'Chattisgarh': '22', 'Chhattisgarh': '22',
  'Madhya Pradesh': '23', 'Gujarat': '24',
  'Dadra and Nagar Haveli and Daman and Diu': '26', 'Maharashtra': '27',
  'Karnataka': '29', 'Goa': '30', 'Lakshadweep': '31', 'Kerala': '32',
  'Tamil Nadu': '33', 'Puducherry': '34', 'Andaman and Nicobar Islands': '35',
  'Telangana': '36', 'Andhra Pradesh': '37', 'Ladakh': '38',
};

/** Tolerates the spelling drift the upstream API shows between records. */
function gstStateCode(state: string): string | null {
  const direct = GST_STATE_CODES[state];
  if (direct) return direct;
  const norm = state.trim().toLowerCase();
  for (const [k, v] of Object.entries(GST_STATE_CODES)) {
    if (k.toLowerCase() === norm) return v;
  }
  return null;
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
        pincode: po.Pincode,
        city: po.District,
        state: po.State,
        // null when the state name is one we do not have a code for — the client
        // then asks the customer rather than guessing a tax jurisdiction.
        stateCode: gstStateCode(po.State),
        country: po.Country,
      });
    },
  );
};

export default pincodeRoutes;
