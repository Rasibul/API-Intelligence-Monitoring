import { Router } from 'express';
import { healthRoutes } from '../modules/health/health.route.js';
import type { ReadinessAccess } from '../modules/health/health.route.js';

export function createRoutes(access?: ReadinessAccess): Router {
  const routes = Router();
  routes.use(healthRoutes(access));
  // Domain endpoints will be registered under /api/v1 in their own implementation steps.
  return routes;
}
