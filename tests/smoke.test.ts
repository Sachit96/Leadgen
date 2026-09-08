import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { installTestEnv } from './helpers/env';
import { createTestDb } from './helpers/db';
import { organizations } from '@/lib/db/schema';
import type { Db } from '@/lib/db';

installTestEnv();

describe('database migrations', () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  it('applies the full schema and round-trips a row', async () => {
    const [org] = await db
      .insert(organizations)
      .values({ name: 'Test Org', slug: 'test-org' })
      .returning();
    expect(org?.name).toBe('Test Org');
    expect(org?.timezone).toBe('America/Toronto');
  });
});
