import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import * as ctrl from './access.controller.js';
import {
  HardwareKeyChallengeBody,
  PasswordResetCompleteBody,
  PasswordResetStartBody,
} from './access.validators.js';

const authAccessRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/admin/hardware-key-challenge',
    { schema: { body: HardwareKeyChallengeBody } },
    async (req) => ctrl.hardwareKeyChallenge({ body: req.body }),
  );

  app.post(
    '/password-reset/start',
    { schema: { body: PasswordResetStartBody } },
    async (req) => ctrl.passwordResetStart({ body: req.body, log: req.log }),
  );

  app.post(
    '/password-reset/complete',
    { schema: { body: PasswordResetCompleteBody } },
    async (req) => ctrl.passwordResetComplete({ body: req.body }),
  );
};

export default authAccessRoutes;
