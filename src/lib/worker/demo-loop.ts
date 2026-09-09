import { logger } from '@/lib/core/logger';
import { tick } from './tick';

declare global {
  var __onRadarDemoLoop: NodeJS.Timeout | undefined;
}

/**
 * Runs the worker inside the app process, for demo mode only.
 *
 * The embedded database is single-process, so a separate `npm run worker`
 * cannot open it — this is what makes `npm run dev` alone a complete working
 * system. Deliberately started from the app's server bundle rather than from
 * `instrumentation.ts`: that file is its own webpack entry where
 * `serverExternalPackages` does not apply, so importing the worker from there
 * drags `pg` in and the build fails resolving 'fs'.
 *
 * Idempotent — safe to call on every render.
 */
export function startDemoWorker(): void {
  if (process.env.DEMO_MODE !== 'true') return;
  if (globalThis.__onRadarDemoLoop) return;

  const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 5000);
  logger.info('demo mode: running the worker in-process', { intervalMs });

  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void tick()
      .catch((error: unknown) => {
        logger.error('in-process worker tick failed', {
          errorCode: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        });
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  timer.unref();
  globalThis.__onRadarDemoLoop = timer;
}
