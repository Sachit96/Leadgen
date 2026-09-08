/**
 * Long-lived background worker.
 *
 * Runs the same `tick()` the HTTP route runs, on an interval, with graceful
 * shutdown so an in-flight send is never abandoned mid-flight.
 */
import 'dotenv/config';
import { tick } from '../src/lib/worker/tick';
import { logger } from '../src/lib/core/logger';

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 5_000);

let running = true;
let inFlight: Promise<unknown> | null = null;

async function main() {
  logger.info('worker started', { intervalMs: INTERVAL_MS, pid: process.pid });

  while (running) {
    const startedAt = Date.now();
    try {
      inFlight = tick();
      await inFlight;
    } catch (error) {
      logger.error('worker tick threw', {
        errorCode: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
    } finally {
      inFlight = null;
    }

    const elapsed = Date.now() - startedAt;
    const wait = Math.max(0, INTERVAL_MS - elapsed);
    if (running && wait > 0) await sleep(wait);
  }

  logger.info('worker stopped');
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (!running) process.exit(0);
    logger.info('worker draining', { signal });
    running = false;
    if (inFlight) await inFlight.catch(() => undefined);
  });
}

main().catch((error) => {
  logger.error('worker crashed', { errorCode: String(error).slice(0, 200) });
  process.exit(1);
});
