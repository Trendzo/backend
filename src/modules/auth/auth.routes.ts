import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import * as ctrl from './auth.controller.js';
import { LoginBody, Msg91VerifyBody, ReviewLoginBody, SignupBody } from './auth.validators.js';

const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post('/admin/login', { schema: { body: LoginBody } }, async (req) =>
    ctrl.adminLogin({ body: req.body }),
  );

  app.post('/consumer/otp/msg91', { schema: { body: Msg91VerifyBody } }, async (req) =>
    ctrl.consumerOtpLogin({ body: req.body }),
  );

  app.post('/retailer/signup', { schema: { body: SignupBody } }, async (req) =>
    ctrl.retailerSignup({ body: req.body }),
  );

  app.post('/retailer/login', { schema: { body: LoginBody } }, async (req) =>
    ctrl.retailerLogin({ body: req.body }),
  );

  app.post('/retailer/otp/msg91', { schema: { body: Msg91VerifyBody } }, async (req) =>
    ctrl.retailerOtpLogin({ body: req.body }),
  );

  app.post('/retailer/review-login', { schema: { body: ReviewLoginBody } }, async (req) =>
    ctrl.retailerReviewLogin({ body: req.body }),
  );

  app.post(
    '/driver/otp/msg91',
    { schema: { body: Msg91VerifyBody } },
    async (req) => ctrl.driverOtpLogin({ body: req.body }),
  );
};

export default authRoutes;
