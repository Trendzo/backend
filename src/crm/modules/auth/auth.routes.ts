import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ok } from '@/shared/http/envelope.js';
import { getAuth } from '@/shared/auth/middleware.js';
import { requireAnyCrmAuth, resolveActor } from '../../auth.js';
import * as ctrl from './auth.controller.js';
import { CrmMsg91Body, CrmRequestOtpBody, CrmVerifyOtpBody } from './auth.validators.js';

/**
 * CRM auth surface. Mounted at `/crm/auth`.
 *
 * Admin sign-in is deliberately NOT here — admins use the platform's existing
 * `POST /auth/admin/login` and carry that token straight into the CRM's admin routes. One
 * admin identity serves both the web portal and this CRM.
 */
const crmAuthRoutes: FastifyPluginAsyncZod = async (app) => {
  /** Tells the client which sign-in paths are live, so the login page can adapt. */
  app.get('/config', () => ok({ devOtp: ctrl.devOtpEnabled() }));

  app.post('/otp/msg91', { schema: { body: CrmMsg91Body } }, async (req) =>
    ctrl.salesMsg91Login({ body: req.body }),
  );

  // Available in both modes: validates the number (and names the person) before the client
  // spends an SMS. Only returns a code when the local OTP path is armed.
  app.post('/otp/request', { schema: { body: CrmRequestOtpBody } }, async (req) =>
    ctrl.startSignIn({ body: req.body }),
  );

  app.post('/otp/verify', { schema: { body: CrmVerifyOtpBody } }, async (req) =>
    ctrl.verifyDevOtp({ body: req.body }),
  );

  app.get('/me', { preHandler: requireAnyCrmAuth }, async (req) => {
    const actor = await resolveActor(req);
    return ctrl.me({
      actorKind: actor.kind,
      id: actor.id,
      name: actor.name,
    });
  });

  /**
   * Sign-out is stateless (JWT, no server session table) — the client drops its cookie.
   * The endpoint exists so the frontend has one symmetric call and so future token
   * revocation has a place to live.
   */
  app.post('/logout', { preHandler: requireAnyCrmAuth }, async (req) => {
    getAuth(req);
    return ok({ ok: true });
  });
};

export default crmAuthRoutes;
