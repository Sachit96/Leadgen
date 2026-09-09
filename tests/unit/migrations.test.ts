import { describe, it, expect, afterEach } from 'vitest';
import { installTestEnv } from '../helpers/env';
import { createTestDb } from '../helpers/db';
import { sql } from 'drizzle-orm';
import type { Db } from '@/lib/db';

installTestEnv();

describe('migrations', () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (close) await close();
    close = null;
  });

  it('applies every migration cleanly and creates the lead-gen and calling tables', async () => {
    const harness = await createTestDb();
    close = harness.close;
    const db: Db = harness.db;

    const rows = await db.execute(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name
    `);
    const tables = ((rows as unknown as { rows: Record<string, unknown>[] }).rows ?? []).map((r) =>
      String(r.table_name),
    );

    // The pre-existing CRM must survive the migration untouched.
    for (const existing of ['contacts', 'companies', 'campaigns', 'conversations', 'messages', 'pipeline_deals']) {
      expect(tables, `existing table ${existing}`).toContain(existing);
    }

    for (const added of [
      'saved_searches',
      'lead_search_jobs',
      'lead_discovery_records',
      'duplicate_matches',
      'lead_jobs',
      'lead_enrichment',
      'lead_signals',
      'lead_personalization',
      'call_queues',
      'call_queue_items',
      'call_attempts',
    ]) {
      expect(tables, `new table ${added}`).toContain(added);
    }
  });
});
