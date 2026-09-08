import { installTestEnv } from './env';
import { createTestDb } from './db';
import { MockSmsProvider, setSmsProvider } from '@/lib/providers/sms';
import { MockAiProvider, setAiProvider } from '@/lib/providers/ai';
import { InternalCalendarProvider, setCalendarProvider } from '@/lib/providers/calendar';
import { seedMinimalOrg } from '@/lib/seed/demo';
import { updateOrgConfig } from '@/lib/services/settings';
import { setCampaignStatus, updateCampaign } from '@/lib/services/campaigns';
import type { Ctx } from '@/lib/auth/context';
import type { Db } from '@/lib/db';

export type Harness = {
  db: Db;
  ctx: Ctx;
  campaignId: string;
  sms: MockSmsProvider;
  ai: MockAiProvider;
  close: () => Promise<void>;
};

/**
 * Boots the whole application stack against in-memory Postgres with mock
 * providers: real migrations, real services, real queue, real agent loop.
 *
 * Sending windows are opened to 24/7 so tests do not depend on the wall clock
 * of the machine running them.
 */
export async function createHarness(): Promise<Harness> {
  installTestEnv();
  const { db, close } = await createTestDb();

  const sms = new MockSmsProvider();
  const ai = new MockAiProvider();
  setSmsProvider(sms);
  setAiProvider(ai);
  setCalendarProvider(new InternalCalendarProvider());

  const { ctx, campaignId } = await seedMinimalOrg();

  await updateOrgConfig(ctx, {
    sending: {
      quietHoursStart: '00:00',
      quietHoursEnd: '00:00',
      sendingDays: [0, 1, 2, 3, 4, 5, 6],
      contactCooldownMinutes: 0,
      maxAutomatedPerContactPerDay: 20,
      dailyOrgCap: 1000,
    },
  });

  await updateCampaign(ctx, campaignId, {
    sendingWindowStart: '00:00',
    sendingWindowEnd: '23:59',
    sendingDays: [0, 1, 2, 3, 4, 5, 6],
  });

  await setCampaignStatus(ctx, campaignId, 'ACTIVE');

  return {
    db,
    ctx,
    campaignId,
    sms,
    ai,
    close: async () => {
      setSmsProvider(undefined);
      setAiProvider(undefined);
      setCalendarProvider(undefined);
      await close();
    },
  };
}

/** Simulates the provider POSTing an inbound message webhook. */
export function inboundWebhook(from: string, to: string, body: string, sid = `IN${Date.now()}${Math.random()}`) {
  return {
    providerMessageId: sid,
    from,
    to,
    body,
    receivedAt: new Date(),
    dedupeKey: `mock:inbound:${sid}`,
    raw: { From: from, To: to, Body: body },
  };
}
