import { describe, it, expect, afterEach } from 'vitest';
import { isInMemory, isEmbedded, embeddedPath } from '@/lib/db/embedded';
import { resetEnvCache } from '@/lib/env';

/**
 * UI preview mode exists to remove the *setup*, not the database. These pin the
 * two properties that make it safe: it is off unless asked for, and its
 * conveniences — a default signing secret above all — are unreachable without
 * the flag.
 */
describe('ui preview mode', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    resetEnvCache();
  });

  it('recognises an in-memory url without touching the disk-backed one', () => {
    expect(isEmbedded('pglite://memory')).toBe(true);
    expect(isInMemory('pglite://memory')).toBe(true);
    expect(isInMemory('pglite://:memory:')).toBe(true);

    // The normal embedded database is a directory, and must not be mistaken
    // for the throwaway one — seeding over someone's data would be worse than
    // any startup error.
    expect(isInMemory('pglite://./data/onradar')).toBe(false);
    expect(embeddedPath('pglite://./data/onradar')).toBe('./data/onradar');
    expect(isInMemory('postgres://localhost/onradar')).toBe(false);
  });

  it('supplies a database and a secret only when the flag is set', async () => {
    process.env.UI_PREVIEW = 'true';
    delete process.env.DATABASE_URL;
    delete process.env.SESSION_SECRET;
    resetEnvCache();

    const { env } = await import('@/lib/env');
    const e = env();
    expect(e.DATABASE_URL).toBe('pglite://memory');
    expect(e.SESSION_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(e.UI_PREVIEW).toBe('true');
  });

  it('still refuses to start with nothing configured and the flag off', async () => {
    process.env.UI_PREVIEW = 'false';
    delete process.env.DATABASE_URL;
    delete process.env.SESSION_SECRET;
    resetEnvCache();

    const { env } = await import('@/lib/env');
    // The default secret is not a fallback anyone can reach by accident: with
    // the flag off, a missing DATABASE_URL is still a hard failure.
    expect(() => env()).toThrow(/DATABASE_URL/);
  });

  it('never overrides values that were configured', async () => {
    process.env.UI_PREVIEW = 'true';
    process.env.DATABASE_URL = 'postgres://localhost:5432/real';
    process.env.SESSION_SECRET = 'a'.repeat(48);
    resetEnvCache();

    const { env } = await import('@/lib/env');
    const e = env();
    expect(e.DATABASE_URL).toBe('postgres://localhost:5432/real');
    expect(e.SESSION_SECRET).toBe('a'.repeat(48));
  });
});
