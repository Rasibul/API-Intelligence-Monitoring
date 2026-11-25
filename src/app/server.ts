import { bootstrap } from './bootstrap.js';
import { createMongoManager } from './config/database.js';
import { loadEnvironment } from './config/env.js';
import { createRedisManager } from './config/redis.js';

await bootstrap({
  loadConfig: loadEnvironment,
  createDependencies: (config) => [
    createMongoManager(config),
    createRedisManager(config),
  ],
});
