import { Router } from 'express';
import { health, live } from './health.controller.js';

export const healthRoutes = Router();
healthRoutes.get('/health', health);
healthRoutes.get('/live', live);
