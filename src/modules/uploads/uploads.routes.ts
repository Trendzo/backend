import type { FastifyPluginAsync } from 'fastify';
import * as ctrl from './uploads.controller.js';

const uploadRoutes: FastifyPluginAsync = async (app) => {
  app.post('/', async (req) => ctrl.uploadMedia(req));
};

export default uploadRoutes;
