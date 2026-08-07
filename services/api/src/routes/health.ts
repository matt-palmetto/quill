import type { FastifyInstance } from 'fastify';
import { pgReachable } from '../lib/pg.js';
import { meiliReachable } from '../lib/meili.js';

export function registerHealthRoutes(app: FastifyInstance): void {
  // Liveness: always 200, no dependency checks.
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Readiness: Meili + Postgres must both be reachable.
  app.get('/readyz', async (_request, reply) => {
    const [pg, meili] = await Promise.all([pgReachable(), meiliReachable()]);
    if (!pg || !meili) {
      reply.code(503);
      return { status: 'not ready', pg, meili };
    }
    return { status: 'ready', pg, meili };
  });
}
