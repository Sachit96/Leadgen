/**
 * Runs once when the server starts, before any request is handled.
 *
 * Opens the embedded database, which needs an async open before any request
 * handler calls getDb(). A served Postgres needs nothing here — its pool is
 * created lazily on first use.
 *
 * Deliberately imports only the pg-free module: Next bundles this file as its
 * own entry, where `serverExternalPackages` does not apply, so anything that
 * reaches `pg` from here fails the build resolving 'fs'.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { isEmbedded, initEmbeddedDb } = await import('@/lib/db/embedded');
  const { logger } = await import('@/lib/core/logger');

  if (isEmbedded()) {
    await initEmbeddedDb();
    logger.info('database ready', { provider: 'embedded' });
  }

}
