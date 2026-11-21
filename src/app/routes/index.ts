import { Router } from 'express';
import { healthRoutes } from '../modules/health/health.route.js';

export const routes = Router();
routes.use(healthRoutes);
// Domain endpoints will be registered under /api/v1 in their own implementation steps.
