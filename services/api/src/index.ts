import Fastify from 'fastify';
import { config } from './config.js';
import { registerSearchRoute } from './routes/search.js';
import { registerOpsRoute } from './routes/ops.js';
import { registerHealthRoutes } from './routes/health.js';

const app = Fastify({ logger: true });

registerHealthRoutes(app);
registerSearchRoute(app);
registerOpsRoute(app);

app.listen({ port: config.port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
