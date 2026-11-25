import { Router } from 'express';
import { watchdogAuth } from '../../middlewares/watchdogAuth.middleware.js';
import { health, live, ready } from './health.controller.js';
import type { Readiness } from './readiness.service.js';

export interface ReadinessAccess {
  readiness: Readiness;
  watchdogToken: string;
}

export function healthRoutes(access?: ReadinessAccess): Router {
  const router = Router();
  router.get('/health', health);
  router.get('/live', live);
  // Without a credential the route does not exist, so it cannot be public.
  if (access)
    router.get(
      '/ready',
      watchdogAuth(access.watchdogToken),
      ready(access.readiness),
    );
  return router;
}
