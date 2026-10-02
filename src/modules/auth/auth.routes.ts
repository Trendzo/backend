import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ok } from '@/shared/http/envelope.js';
import * as ctrl from './auth.controller.js';
import { OtpLoginBody } from '@/shared/otp/body.js';
import { getOtpConfig } from '@/shared/otp/config.js';
import { LoginBody, SignupBody } from './auth.validators.js';

const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post('/admin/login', { schema: { body: LoginBody } }, async (req) =>
    ctrl.adminLogin({ body: req.body }),
  );

  /**
   * Which OTP provider clients must use and how (length, resend, Slide's public widget
   * id + client token). Public by design; never carries a server secret.
   */
  app.get('/otp-config', async () => ok(await getOtpConfig()));

  // Phone-OTP logins. `/otp/login` is the provider-neutral path; `/otp/msg91` is kept
  // because shipped app builds only know that one (they send untagged MSG91 tokens).
  for (const path of ['/consumer/otp/login', '/consumer/otp/msg91']) {
    app.post(path, { schema: { body: OtpLoginBody } }, async (req) =>
      ctrl.consumerOtpLogin({ body: req.body }),
    );
  }

  app.post('/retailer/signup', { schema: { body: SignupBody } }, async (req) =>
    ctrl.retailerSignup({ body: req.body }),
  );

  app.post('/retailer/login', { schema: { body: LoginBody } }, async (req) =>
    ctrl.retailerLogin({ body: req.body }),
  );

  for (const path of ['/retailer/otp/login', '/retailer/otp/msg91']) {
    app.post(path, { schema: { body: OtpLoginBody } }, async (req) =>
      ctrl.retailerOtpLogin({ body: req.body }),
    );
  }

  for (const path of ['/driver/otp/login', '/driver/otp/msg91']) {
    app.post(path, { schema: { body: OtpLoginBody } }, async (req) =>
      ctrl.driverOtpLogin({ body: req.body }),
    );
  }
};

export default authRoutes;
