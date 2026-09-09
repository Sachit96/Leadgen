import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { organizations, users } from '@/lib/db/schema';
import { createHarness, type Harness } from '../helpers/harness';
import { seedMinimalOrg } from '@/lib/seed/demo';
import { createProspect, getProspect, listProspects } from '@/lib/services/contacts';
import { getCampaign, listCampaigns } from '@/lib/services/campaigns';
import { getOrCreateConversation, getConversation, listInbox } from '@/lib/services/conversations';
import { listMessages, queueOutbound } from '@/lib/services/messages';
import { funnelMetrics, resolveRange } from '@/lib/services/analytics';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { createSession, resolveSession, destroySession } from '@/lib/auth/session';
import { can, assertCan } from '@/lib/auth/rbac';
import { TwilioProvider } from '@/lib/providers/sms';
import type { Ctx } from '@/lib/auth/context';
import { getDb } from '@/lib/db';

describe('tenant isolation', () => {
  let h: Harness;
  let other: Ctx;

  beforeEach(async () => {
    h = await createHarness();
    ({ ctx: other } = await seedMinimalOrg('Other Org'));
  });
  afterEach(async () => h.close());

  it('never returns another organization rows through any list', async () => {
    const mine = await createProspect(h.ctx, {
      phone: '4165551001',
      firstName: 'Mine',
      company: { name: 'My Roofing', city: 'Toronto', industry: 'Roofing' },
    });
    const theirs = await createProspect(other, {
      phone: '4165551002',
      firstName: 'Theirs',
      company: { name: 'Their Roofing', city: 'Toronto', industry: 'Roofing' },
    });

    const myConversation = await getOrCreateConversation(h.ctx, mine.id);
    const theirConversation = await getOrCreateConversation(other, theirs.id);
    await queueOutbound(h.ctx, {
      conversationId: myConversation.id,
      body: 'mine',
      author: 'HUMAN',
      idempotencyKey: 'iso-mine',
    });
    await queueOutbound(other, {
      conversationId: theirConversation.id,
      body: 'theirs',
      author: 'HUMAN',
      idempotencyKey: 'iso-theirs',
    });

    const myProspects = await listProspects(h.ctx);
    expect(myProspects.total).toBe(1);
    expect(myProspects.rows[0]?.id).toBe(mine.id);

    const myInbox = await listInbox(h.ctx);
    expect(myInbox.rows.map((r) => r.contactId)).toEqual([mine.id]);

    const myCampaigns = await listCampaigns(h.ctx);
    expect(myCampaigns).toHaveLength(1);

    // Analytics aggregate only over the caller's organization.
    const myMetrics = await funnelMetrics(h.ctx, resolveRange('all'));
    expect(myMetrics.prospectsContacted).toBe(1);
  });

  it('refuses to read another organization row by id', async () => {
    const theirs = await createProspect(other, {
      phone: '4165551003',
      firstName: 'Theirs',
      company: { name: 'Their Roofing', city: 'Toronto', industry: 'Roofing' },
    });
    const theirConversation = await getOrCreateConversation(other, theirs.id);
    const theirCampaign = (await listCampaigns(other))[0]!.campaign;

    // Knowing the id is not authorization.
    await expect(getProspect(h.ctx, theirs.id)).rejects.toThrow(/not found/i);
    await expect(getConversation(h.ctx, theirConversation.id)).rejects.toThrow(/not found/i);
    await expect(getCampaign(h.ctx, theirCampaign.id)).rejects.toThrow(/not found/i);
  });

  it('refuses to write into another organization conversation', async () => {
    const theirs = await createProspect(other, {
      phone: '4165551004',
      company: { name: 'Their Roofing', city: 'Toronto', industry: 'Roofing' },
    });
    const theirConversation = await getOrCreateConversation(other, theirs.id);

    await expect(
      queueOutbound(h.ctx, {
        conversationId: theirConversation.id,
        body: 'should not be possible',
        author: 'HUMAN',
        idempotencyKey: 'cross-tenant',
      }),
    ).rejects.toThrow(/not found/i);

    expect(await listMessages(other, theirConversation.id)).toHaveLength(0);
  });
});

describe('passwords and sessions', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => h.close());

  it('hashes passwords with a per-password salt and verifies constant-time', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');

    expect(a).not.toBe(b); // salted, so identical passwords differ
    expect(a.startsWith('scrypt:')).toBe(true);
    expect(a).not.toContain('correct horse');

    expect(await verifyPassword('correct horse battery staple', a)).toBe(true);
    expect(await verifyPassword('wrong password', a)).toBe(false);
    expect(await verifyPassword('anything', 'garbage')).toBe(false);
  });

  it('rejects a too-short password rather than storing a weak one', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least 8/i);
  });

  it('stores only a hash of the session token and expires sessions', async () => {
    const db = getDb();
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, h.ctx.organizationId));

    const [user] = await db
      .insert(users)
      .values({
        email: 'session@test.local',
        name: 'Session User',
        passwordHash: await hashPassword('a-good-password'),
      })
      .returning();

    const { memberships } = await import('@/lib/db/schema');
    await db
      .insert(memberships)
      .values({ organizationId: org!.id, userId: user!.id, role: 'SALES_REP' });

    const { token } = await createSession(user!.id, org!.id);

    const { sessions } = await import('@/lib/db/schema');
    const stored = await db.select().from(sessions).where(eq(sessions.userId, user!.id));
    // The raw token must never be recoverable from the database.
    expect(stored[0]?.tokenHash).not.toBe(token);
    expect(stored[0]?.tokenHash).not.toContain(token);

    const resolved = await resolveSession(token);
    expect(resolved?.userId).toBe(user!.id);
    expect(resolved?.role).toBe('SALES_REP');

    expect(await resolveSession('not-a-real-token')).toBeNull();
    expect(await resolveSession(undefined)).toBeNull();

    await destroySession(token);
    expect(await resolveSession(token)).toBeNull();
  });
});

describe('role permissions', () => {
  it('grants and withholds the right capabilities per role', () => {
    expect(can('OWNER', 'campaign:launch')).toBe(true);
    expect(can('ADMIN', 'campaign:launch')).toBe(true);
    expect(can('SALES_REP', 'campaign:launch')).toBe(false);

    expect(can('SALES_REP', 'message:send')).toBe(true);
    expect(can('VIEWER', 'message:send')).toBe(false);

    expect(can('VIEWER', 'prospect:read')).toBe(true);
    expect(can('VIEWER', 'prospect:write')).toBe(false);

    expect(can('SALES_REP', 'settings:write')).toBe(false);
    expect(can('SALES_REP', 'ai:configure')).toBe(false);
  });

  it('throws with an actionable message when a role lacks permission', () => {
    expect(() => assertCan('VIEWER', 'message:send')).toThrow(/VIEWER.*message:send/);
    expect(() => assertCan('OWNER', 'message:send')).not.toThrow();
  });
});

describe('webhook signature verification', () => {
  const provider = new TwilioProvider({
    accountSid: 'AC_test',
    authToken: 'test-auth-token',
    defaultFrom: '+15550001111',
  });

  const url = 'https://app.example.com/api/webhooks/sms/inbound';
  const params = { MessageSid: 'SM123', From: '+14165550142', To: '+15550001111', Body: 'yes' };

  /** Reproduces Twilio's scheme: HMAC-SHA1 over url + sorted key/value pairs. */
  function sign(authToken: string, target: string, body: Record<string, string>): string {
    const data = Object.keys(body)
      .sort()
      .reduce((acc, key) => acc + key + body[key], target);
    return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  }

  it('accepts a correctly signed request', () => {
    const signature = sign('test-auth-token', url, params);
    expect(
      provider.verifyWebhook({
        url,
        headers: { 'x-twilio-signature': signature },
        rawBody: new URLSearchParams(params).toString(),
        params,
      }),
    ).toBe(true);
  });

  it('rejects a forged or tampered request', () => {
    const signature = sign('test-auth-token', url, params);

    // Wrong signing key.
    expect(
      provider.verifyWebhook({
        url,
        headers: { 'x-twilio-signature': sign('attacker-token', url, params) },
        rawBody: '',
        params,
      }),
    ).toBe(false);

    // Body changed after signing.
    expect(
      provider.verifyWebhook({
        url,
        headers: { 'x-twilio-signature': signature },
        rawBody: '',
        params: { ...params, Body: 'STOP' },
      }),
    ).toBe(false);

    // Replayed against a different URL.
    expect(
      provider.verifyWebhook({
        url: 'https://evil.example.com/api/webhooks/sms/inbound',
        headers: { 'x-twilio-signature': signature },
        rawBody: '',
        params,
      }),
    ).toBe(false);

    // No signature at all.
    expect(provider.verifyWebhook({ url, headers: {}, rawBody: '', params })).toBe(false);
  });

  it('returns null from handleInbound when verification fails', async () => {
    expect(
      await provider.handleInbound({ url, headers: {}, rawBody: '', params }),
    ).toBeNull();
  });
});
