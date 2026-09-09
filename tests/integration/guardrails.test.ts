import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { contacts, messages, outboundJobs } from '@/lib/db/schema';
import { createHarness, inboundWebhook, type Harness } from '../helpers/harness';
import { createProspect } from '@/lib/services/contacts';
import { getOrCreateConversation } from '@/lib/services/conversations';
import {
  applyDeliveryUpdate,
  findByProviderMessageId,
  queueOutbound,
  recordProviderEvent,
} from '@/lib/services/messages';
import { updateOrgConfig } from '@/lib/services/settings';
import { enrollProspects, updateCampaign } from '@/lib/services/campaigns';
import { isSuppressed, suppress } from '@/lib/services/suppression';
import { handleInboundMessage } from '@/lib/services/inbound';
import { tick } from '@/lib/worker/tick';

const SENDING_NUMBER = '+15550001111';

async function makeProspect(h: Harness, phone: string, name = 'Test') {
  return createProspect(h.ctx, {
    phone,
    firstName: name,
    company: { name: `${name} Roofing`, city: 'Toronto', industry: 'Roofing' },
  });
}

describe('sending guardrails', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => h.close());

  it('defers rather than sends outside the quiet-hours window', async () => {
    // Close the window entirely: quiet hours from 00:00 to 23:59 leaves no
    // permitted minute, so an automated message must wait rather than go out.
    await updateOrgConfig(h.ctx, {
      sending: { quietHoursStart: '00:01', quietHoursEnd: '00:00' },
    });

    const prospect = await makeProspect(h, '4165552001', 'Quiet');
    const conversation = await getOrCreateConversation(h.ctx, prospect.id);
    await queueOutbound(h.ctx, {
      conversationId: conversation.id,
      body: 'Should wait for the window.',
      author: 'SYSTEM',
      idempotencyKey: 'quiet-hours',
    });

    const result = await tick();
    expect(result.sends.deferred).toBe(1);
    expect(h.sms.outbox()).toHaveLength(0);

    const job = (
      await h.db.select().from(outboundJobs).where(eq(outboundJobs.conversationId, conversation.id))
    )[0]!;
    expect(job.status).toBe('PENDING');
    expect(job.lastError).toContain('outside sending window');
    // A deferral must not burn a retry attempt.
    expect(job.attempts).toBe(0);

    // A human reply is not subject to the automated window.
    await queueOutbound(h.ctx, {
      conversationId: conversation.id,
      body: 'A person is replying right now.',
      author: 'HUMAN',
      idempotencyKey: 'human-anytime',
    });
    await tick();
    expect(h.sms.outbox()).toHaveLength(1);
    expect(h.sms.lastMessage()?.body).toContain('A person is replying');
  });

  it('holds sending once the organization daily cap is reached', async () => {
    await updateOrgConfig(h.ctx, { sending: { dailyOrgCap: 2 } });

    for (let i = 0; i < 4; i += 1) {
      const prospect = await makeProspect(h, `41655530${10 + i}`, `Cap${i}`);
      const conversation = await getOrCreateConversation(h.ctx, prospect.id);
      await queueOutbound(h.ctx, {
        conversationId: conversation.id,
        body: `Message ${i}`,
        author: 'SYSTEM',
        idempotencyKey: `cap-${i}`,
      });
    }

    await tick();
    // The cap counts messages created today, so it stops the batch partway.
    expect(h.sms.outbox().length).toBeLessThanOrEqual(2);
    expect(h.sms.outbox().length).toBeGreaterThan(0);
  });

  it('respects the per-contact cooldown between automated messages', async () => {
    await updateOrgConfig(h.ctx, { sending: { contactCooldownMinutes: 120 } });

    const prospect = await makeProspect(h, '4165552003', 'Cooldown');
    const conversation = await getOrCreateConversation(h.ctx, prospect.id);

    await queueOutbound(h.ctx, {
      conversationId: conversation.id,
      body: 'First message.',
      author: 'SYSTEM',
      idempotencyKey: 'cooldown-1',
    });
    await tick();
    expect(h.sms.outbox()).toHaveLength(1);

    await queueOutbound(h.ctx, {
      conversationId: conversation.id,
      body: 'Second message, too soon.',
      author: 'SYSTEM',
      idempotencyKey: 'cooldown-2',
    });
    const result = await tick();

    expect(result.sends.deferred).toBe(1);
    expect(h.sms.outbox()).toHaveLength(1);
  });

  it('stops a campaign once its own daily capacity is spent', async () => {
    await updateCampaign(h.ctx, h.campaignId, { dailyCapacity: 2 });

    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const prospect = await makeProspect(h, `41655540${10 + i}`, `Batch${i}`);
      ids.push(prospect.id);
    }
    await enrollProspects(h.ctx, h.campaignId, ids);

    await tick();
    const sent = await h.db
      .select()
      .from(messages)
      .where(and(eq(messages.campaignId, h.campaignId), eq(messages.direction, 'OUTBOUND')));
    expect(sent.length).toBeLessThanOrEqual(2);
  });

  it('blocks a manually suppressed number from all future sending', async () => {
    const prospect = await makeProspect(h, '4165552005', 'Blocked');
    const conversation = await getOrCreateConversation(h.ctx, prospect.id);

    await suppress(h.ctx, {
      phone: prospect.phone,
      reason: 'MANUAL',
      note: 'Asked us by phone',
      contactId: prospect.id,
    });

    expect(await isSuppressed(h.ctx, prospect.phone)).toBe(true);
    await expect(
      queueOutbound(h.ctx, {
        conversationId: conversation.id,
        body: 'Should be refused',
        author: 'HUMAN',
        idempotencyKey: 'suppressed-manual',
      }),
    ).rejects.toThrow();

    const contact = (await h.db.select().from(contacts).where(eq(contacts.id, prospect.id)))[0]!;
    expect(contact.status).toBe('DO_NOT_CONTACT');
  });
});

describe('delivery webhooks', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => h.close());

  it('advances message status and never regresses it', async () => {
    const prospect = await makeProspect(h, '4165552006', 'Delivery');
    const conversation = await getOrCreateConversation(h.ctx, prospect.id);
    await queueOutbound(h.ctx, {
      conversationId: conversation.id,
      body: 'Tracking delivery.',
      author: 'SYSTEM',
      idempotencyKey: 'delivery-1',
    });
    await tick();

    const providerMessageId = h.sms.lastMessage()!.providerMessageId;
    let message = (await findByProviderMessageId('mock', providerMessageId))!;
    expect(message.status).toBe('SENT');

    await applyDeliveryUpdate(
      {
        providerMessageId,
        status: 'delivered',
        occurredAt: new Date(),
        dedupeKey: 'd1',
        raw: {},
      },
      message,
    );

    message = (await findByProviderMessageId('mock', providerMessageId))!;
    expect(message.status).toBe('DELIVERED');
    expect(message.deliveredAt).toBeTruthy();

    // A late "sent" callback must not undo a delivery already recorded.
    await applyDeliveryUpdate(
      { providerMessageId, status: 'sent', occurredAt: new Date(), dedupeKey: 'd2', raw: {} },
      message,
    );
    message = (await findByProviderMessageId('mock', providerMessageId))!;
    expect(message.status).toBe('DELIVERED');
  });

  it('records a provider event once, however many times it is replayed', async () => {
    const first = await recordProviderEvent(h.ctx.organizationId, {
      kind: 'status',
      dedupeKey: 'replay-me',
      providerKind: 'mock',
      providerMessageId: 'MOCK1',
      payload: {},
    });
    const second = await recordProviderEvent(h.ctx.organizationId, {
      kind: 'status',
      dedupeKey: 'replay-me',
      providerKind: 'mock',
      providerMessageId: 'MOCK1',
      payload: {},
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});

describe('conversation stop states', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => h.close());

  it('does not run an AI turn on a conversation a human owns', async () => {
    const prospect = await makeProspect(h, '4165552007', 'Handoff');
    await enrollProspects(h.ctx, h.campaignId, [prospect.id]);
    await tick();

    await handleInboundMessage(
      h.ctx.organizationId,
      // Negotiation, not a plain pricing question — the agent may quote the
      // price from Settings, but discounts are a person's decision.
      inboundWebhook(prospect.phone, SENDING_NUMBER, 'what discount can you do for a year'),
      'mock',
    );

    // The deterministic check fired, so no model call was made.
    expect(h.ai.calls).toHaveLength(0);

    const before = h.sms.outbox().length;
    await tick();
    await tick();
    expect(h.sms.outbox()).toHaveLength(before);
    expect(h.ai.calls).toHaveLength(0);
  });

  it('answers a plain pricing question rather than escalating it', async () => {
    const prospect = await makeProspect(h, '4165552008', 'Pricing');
    await enrollProspects(h.ctx, h.campaignId, [prospect.id]);
    await tick();

    await handleInboundMessage(
      h.ctx.organizationId,
      inboundWebhook(prospect.phone, SENDING_NUMBER, 'what would this cost us'),
      'mock',
    );

    const result = await tick();
    // Pricing comes from Settings, so the agent is equipped to answer it.
    expect(result.ai.replied).toBe(1);
    expect(result.ai.handoff).toBe(0);
  });
});
