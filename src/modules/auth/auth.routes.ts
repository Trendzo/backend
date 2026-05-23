import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import * as ctrl from './auth.controller.js';
import { LoginBody, SignupBody } from './auth.validators.js';

const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/admin/login',
    { schema: { body: LoginBody } },
    async (req) => ctrl.adminLogin({ body: req.body }),
  );

  app.post(
    '/retailer/signup',
    { schema: { body: SignupBody } },
    async (req) => ctrl.retailerSignup({ body: req.body }),
  );

  app.post(
    '/retailer/login',
    { schema: { body: LoginBody } },
    async (req) => ctrl.retailerLogin({ body: req.body }),
  );
};

export default authRoutes;
