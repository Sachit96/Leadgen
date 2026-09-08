import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  campaignMemberships,
  contacts,
  conversations,
  messages,
  outboundJobs,
  suppressionEntries,
} from '@/lib/db/schema';
import { createHarness, inboundWebhook, type Harness } from '../helpers/harness';
import { commitImport } from '@/lib/services/import';
import { createProspect, getProspect, listProspects } from '@/lib/services/contacts';
import { enrollProspects, pickVariant } from '@/lib/services/campaigns';
import { handleInboundMessage } from '@/lib/services/inbound';
import { bookAppointment, availability } from '@/lib/services/appointments';
import { listPipeline } from '@/lib/services/pipeline';
import { funnelMetrics, resolveRange, variantPerformance } from '@/lib/services/analytics';
import { getQualification, parseFields } from '@/lib/services/qualification';
import { listMessages, queueOutbound, manualIdempotencyKey } from '@/lib/services/messages';
import { isSuppressed } from '@/lib/services/suppression';
import { tick } from '@/lib/worker/tick';
import { ProviderError } from '@/lib/providers/sms';

const SENDING_NUMBER = '+15550001111';

const CSV = `Business Name,Owner,Phone Number,Email,City,Industry,Google Reviews,Website
Summit Ridge Roofing,Mike Delaney,(416) 555-0142,mike@summitridge.ca,Mississauga,Roofing,187,summitridgeroofing.ca
Northgate Exteriors,Sandra Whitfield,905-555-0188,sandra@northgate.com,Oakville,Roofing,94,northgateexteriors.com
Bad Row Co,No Phone,,nobody@example.com,Toronto,Roofing,10,
Summit Ridge Roofing,Mike Delaney,4165550142,dupe@summitridge.ca,Mississauga,Roofing,187,
`;

describe('end-to-end outbound sales loop', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => h.close());

  it('runs a prospect from CSV import all the way to attributed revenue', async () => {
    // 1. Import ------------------------------------------------------------
    const imported = await commitImport(h.ctx, CSV, { filename: 'gta-roofers.csv' });
    expect(imported.created).toBe(2);
    // One row has no phone; one duplicates a phone already in the file.
    expect(imported.skipped).toBe(2);
    expect(imported.errors[0]?.message).toMatch(/missing phone/i);

    const listed = await listProspects(h.ctx);
    expect(listed.total).toBe(2);
    const mike = listed.rows.find((r) => r.companyName === 'Summit Ridge Roofing')!;
    expect(mike.phone).toBe('+14165550142');

    // 2. Scoring is transparent -------------------------------------------
    const { contact } = await getProspect(h.ctx, mike.id);
    expect(contact.score).toBeGreaterThan(0);
    expect(contact.scoreBucket).toBeTruthy();
    const breakdown = contact.scoreBreakdown as Array<{ key: string; reason: string }>;
    expect(breakdown.find((b) => b.key === 'reviews_50_plus')?.reason).toContain('187');

    // 3. Enrol and let the sequence run ------------------------------------
    const enrolled = await enrollProspects(h.ctx, h.campaignId, [mike.id]);
    expect(enrolled.enrolled).toBe(1);

    const first = await tick();
    expect(first.sequences.queued).toBe(1);
    expect(first.sends.sent).toBe(1);

    // 4. The message that actually went out --------------------------------
    const sent = h.sms.lastMessage()!;
    expect(sent.to).toBe('+14165550142');
    expect(sent.from).toBe(SENDING_NUMBER);
    expect(sent.body).not.toMatch(/\{\{/); // never ship an unresolved variable
    expect(sent.body).toContain('Summit Ridge Roofing');
    expect(sent.body).toContain('Reply STOP to opt out.');

    const afterSend = await getProspect(h.ctx, mike.id);
    expect(afterSend.contact.status).toBe('CONTACTED');
    expect(afterSend.conversation?.state).toBe('OPENING');

    // 5. Prospect replies --------------------------------------------------
    const conversationId = afterSend.conversation!.id;
    const outcome = await handleInboundMessage(
      h.ctx.organizationId,
      inboundWebhook('+14165550142', SENDING_NUMBER, 'yes, tell me more'),
      'mock',
    );
    expect(outcome.intent).toBe('positive');
    expect(outcome.aiQueued).toBe(true);

    // A reply halts the rest of the sequence.
    const membership = await h.db
      .select()
      .from(campaignMemberships)
      .where(eq(campaignMemberships.contactId, mike.id));
    expect(membership[0]?.status).toBe('COMPLETED');
    expect(membership[0]?.stoppedReason).toBe('replied');

    // 6. The AI answers ----------------------------------------------------
    h.ai.script(
      JSON.stringify({
        message: 'Good to hear. Roughly how many estimates a month go out without closing?',
        conversation_state: 'DISCOVERY',
        intent: 'positive',
        confidence: 0.9,
        lead_temperature: 'warm',
        next_action: 'ask_followup',
        qualification_updates: { monthly_lead_volume: 45 },
        requires_human: false,
        handoff_reason: null,
        follow_up_in_minutes: null,
      }),
    );

    const second = await tick();
    expect(second.ai.replied).toBe(1);
    expect(second.sends.sent).toBe(1);

    const transcript = await listMessages(h.ctx, conversationId);
    const aiReply = transcript.find((m) => m.author === 'AI')!;
    expect(aiReply.body).toContain('estimates a month');
    expect(aiReply.status).toBe('SENT');
    expect(aiReply.promptVersion).toMatch(/^sales\./);

    // 7. Qualification was captured from what they said --------------------
    const qualification = await getQualification(h.ctx, conversationId);
    const fields = parseFields(qualification?.fields);
    expect(fields.monthly_lead_volume?.value).toBe(45);
    expect(fields.monthly_lead_volume?.source).toBe('ai');

    // 8. Book the appointment ---------------------------------------------
    const slots = await availability(h.ctx, { days: 7 });
    expect(slots.length).toBeGreaterThan(0);
    const appointment = await bookAppointment(h.ctx, {
      contactId: mike.id,
      conversationId,
      startsAt: slots[0]!.startsAt,
    });
    expect(appointment.status).toBe('SCHEDULED');

    const booked = await getProspect(h.ctx, mike.id);
    expect(booked.contact.status).toBe('APPOINTMENT');
    expect(booked.conversation?.state).toBe('BOOKED');

    // 9. Pipeline picked it up with attribution intact ---------------------
    const pipeline = await listPipeline(h.ctx);
    expect(pipeline).toHaveLength(1);
    expect(pipeline[0]!.deal.stage).toBe('APPOINTMENT');
    expect(pipeline[0]!.deal.campaignId).toBe(h.campaignId);
    // The variant that opened the conversation is carried onto the deal.
    expect(pipeline[0]!.deal.variantId).toBeTruthy();

    // 10. Analytics are computed from those rows ---------------------------
    const metrics = await funnelMetrics(h.ctx, resolveRange('30d'));
    expect(metrics.prospectsContacted).toBe(1);
    expect(metrics.replies).toBe(1);
    expect(metrics.replyRate).toBe(100);
    expect(metrics.appointments).toBe(1);

    const variants = await variantPerformance(h.ctx, h.campaignId);
    const used = variants.find((v) => v.messages > 0)!;
    expect(used.replies).toBe(1);
    // One message is nowhere near enough to call a winner.
    expect(used.significant).toBe(false);
  });

  it('stops all automation the moment a prospect replies STOP', async () => {
    const prospect = await createProspect(h.ctx, {
      phone: '4165550199',
      firstName: 'Rob',
      company: { name: 'Halton Comfort', city: 'Burlington', industry: 'HVAC' },
    });
    await enrollProspects(h.ctx, h.campaignId, [prospect.id]);
    await tick();
    expect(h.sms.outbox()).toHaveLength(1);

    await handleInboundMessage(
      h.ctx.organizationId,
      inboundWebhook(prospect.phone, SENDING_NUMBER, 'STOP'),
      'mock',
    );

    expect(await isSuppressed(h.ctx, prospect.phone)).toBe(true);

    const after = await getProspect(h.ctx, prospect.id);
    expect(after.contact.status).toBe('DO_NOT_CONTACT');
    expect(after.conversation?.state).toBe('DO_NOT_CONTACT');
    expect(after.conversation?.aiEnabled).toBe(false);

    const membership = await h.db
      .select()
      .from(campaignMemberships)
      .where(eq(campaignMemberships.contactId, prospect.id));
    expect(membership[0]?.status).toBe('STOPPED');

    // Nothing further can be queued, and further ticks send nothing.
    await expect(
      queueOutbound(h.ctx, {
        conversationId: after.conversation!.id,
        body: 'one more thing',
        author: 'HUMAN',
        idempotencyKey: 'test-after-stop',
      }),
    ).rejects.toThrow(/do-not-contact|closed/i);

    const before = h.sms.outbox().length;
    await tick();
    await tick();
    expect(h.sms.outbox()).toHaveLength(before);
  });

  it('cancels an already-queued message when the prospect opts out before it sends', async () => {
    const prospect = await createProspect(h.ctx, {
      phone: '4165550200',
      firstName: 'Dana',
      company: { name: 'Lakeshore Roofing', city: 'Toronto', industry: 'Roofing' },
    });
    const conversationId = (
      await import('@/lib/services/conversations')
    ).getOrCreateConversation;
    const conversation = await conversationId(h.ctx, prospect.id);

    await queueOutbound(h.ctx, {
      conversationId: conversation.id,
      body: 'Checking in about your old estimates.',
      author: 'SYSTEM',
      idempotencyKey: 'queued-before-stop',
    });

    // The STOP lands while the job is still sitting in the queue.
    await handleInboundMessage(
      h.ctx.organizationId,
      inboundWebhook(prospect.phone, SENDING_NUMBER, 'unsubscribe'),
      'mock',
    );

    await tick();
    expect(h.sms.outbox()).toHaveLength(0);

    const jobs = await h.db.select().from(outboundJobs).where(eq(outboundJobs.conversationId, conversation.id));
    expect(jobs[0]?.status).toBe('CANCELLED');
  });

  it('treats webhook retries as idempotent', async () => {
    const prospect = await createProspect(h.ctx, {
      phone: '4165550201',
      firstName: 'Sam',
      company: { name: 'Ridgeview Roofing', city: 'Vaughan', industry: 'Roofing' },
    });
    await enrollProspects(h.ctx, h.campaignId, [prospect.id]);
    await tick();

    const webhook = inboundWebhook(prospect.phone, SENDING_NUMBER, 'sure, what is it', 'FIXED-SID-1');

    const first = await handleInboundMessage(h.ctx.organizationId, webhook, 'mock');
    const second = await handleInboundMessage(h.ctx.organizationId, webhook, 'mock');
    const third = await handleInboundMessage(h.ctx.organizationId, webhook, 'mock');

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(third.duplicate).toBe(true);

    const inbound = await h.db
      .select()
      .from(messages)
      .where(and(eq(messages.contactId, prospect.id), eq(messages.direction, 'INBOUND')));
    expect(inbound).toHaveLength(1);
  });

  it('never double-sends when the same idempotency key is queued twice', async () => {
    const prospect = await createProspect(h.ctx, {
      phone: '4165550202',
      firstName: 'Pat',
      company: { name: 'Cedar Roofing', city: 'Ajax', industry: 'Roofing' },
    });
    const { getOrCreateConversation } = await import('@/lib/services/conversations');
    const conversation = await getOrCreateConversation(h.ctx, prospect.id);

    const key = manualIdempotencyKey(conversation.id, 'Following up on that quote.', h.ctx.userId);
    await queueOutbound(h.ctx, {
      conversationId: conversation.id,
      body: 'Following up on that quote.',
      author: 'HUMAN',
      idempotencyKey: key,
    });
    await queueOutbound(h.ctx, {
      conversationId: conversation.id,
      body: 'Following up on that quote.',
      author: 'HUMAN',
      idempotencyKey: key,
    });

    await tick();
    expect(h.sms.outbox()).toHaveLength(1);
  });

  it('retries a transient provider failure and gives up permanently on a bad number', async () => {
    const prospect = await createProspect(h.ctx, {
      phone: '4165550203',
      firstName: 'Lee',
      company: { name: 'Beacon Roofing', city: 'Whitby', industry: 'Roofing' },
    });
    const { getOrCreateConversation } = await import('@/lib/services/conversations');
    const conversation = await getOrCreateConversation(h.ctx, prospect.id);

    await queueOutbound(h.ctx, {
      conversationId: conversation.id,
      body: 'Quick question about old estimates.',
      author: 'SYSTEM',
      idempotencyKey: 'retry-test',
    });

    h.sms.nextError = new ProviderError('Twilio is rate limiting', { code: '20429', retryable: true });
    const failed = await tick();
    expect(failed.sends.failed).toBe(1);
    expect(h.sms.outbox()).toHaveLength(0);

    let job = (await h.db.select().from(outboundJobs).where(eq(outboundJobs.conversationId, conversation.id)))[0]!;
    // Retryable: back in the queue with a backoff, not dead.
    expect(job.status).toBe('PENDING');
    expect(job.attempts).toBe(1);
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now());

    // Make it due, then fail permanently.
    await h.db.update(outboundJobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(outboundJobs.id, job.id));
    h.sms.failNumbers.add(prospect.phone);
    await tick();

    job = (await h.db.select().from(outboundJobs).where(eq(outboundJobs.id, job.id)))[0]!;
    expect(job.status).toBe('DEAD');

    const message = (await h.db.select().from(messages).where(eq(messages.contactId, prospect.id)))[0]!;
    expect(message.status).toBe('FAILED');
    expect(message.errorCode).toBe('21211');
  });

  it('hands the conversation to a human instead of guessing when the AI fails', async () => {
    const prospect = await createProspect(h.ctx, {
      phone: '4165550204',
      firstName: 'Jo',
      company: { name: 'Maple Roofing', city: 'Markham', industry: 'Roofing' },
    });
    await enrollProspects(h.ctx, h.campaignId, [prospect.id]);
    await tick();

    await handleInboundMessage(
      h.ctx.organizationId,
      inboundWebhook(prospect.phone, SENDING_NUMBER, 'maybe, what is this about'),
      'mock',
    );

    // Both the first attempt and its corrective retry return garbage.
    h.ai.script('this is not json at all', 'still not json');

    const result = await tick();
    expect(result.ai.failed).toBe(1);

    const conversation = (
      await h.db.select().from(conversations).where(eq(conversations.contactId, prospect.id))
    )[0]!;
    expect(conversation.requiresHuman).toBe(true);
    expect(conversation.aiEnabled).toBe(false);
    expect(conversation.handoffReason).toMatch(/AI failed/);

    // Nothing was sent, and a human can still reply by hand.
    const outbound = await h.db
      .select()
      .from(messages)
      .where(and(eq(messages.contactId, prospect.id), eq(messages.author, 'AI')));
    expect(outbound).toHaveLength(0);

    await queueOutbound(h.ctx, {
      conversationId: conversation.id,
      body: 'Hi Jo — Sam here, happy to explain.',
      author: 'HUMAN',
      idempotencyKey: 'human-rescue',
    });
    await tick();
    expect(h.sms.lastMessage()?.body).toContain('Sam here');
  });

  it('escalates rather than replying when the prospect asks for a person', async () => {
    const prospect = await createProspect(h.ctx, {
      phone: '4165550205',
      firstName: 'Kim',
      company: { name: 'Bluewater Roofing', city: 'Pickering', industry: 'Roofing' },
    });
    await enrollProspects(h.ctx, h.campaignId, [prospect.id]);
    await tick();

    await handleInboundMessage(
      h.ctx.organizationId,
      inboundWebhook(prospect.phone, SENDING_NUMBER, 'can I talk to a real person please'),
      'mock',
    );

    const conversation = (
      await h.db.select().from(conversations).where(eq(conversations.contactId, prospect.id))
    )[0]!;
    expect(conversation.requiresHuman).toBe(true);
    expect(conversation.state).toBe('HUMAN_HANDOFF');
    // The deterministic check fired before any model call was made.
    expect(h.ai.calls).toHaveLength(0);
  });

  it('pauses a prospect rather than sending a template with a hole in it', async () => {
    // No company at all, so {{company}} cannot be resolved.
    const prospect = await createProspect(h.ctx, { phone: '4165550206', firstName: 'Alex' });
    await enrollProspects(h.ctx, h.campaignId, [prospect.id]);

    const result = await tick();
    expect(result.sequences.paused).toBe(1);
    expect(h.sms.outbox()).toHaveLength(0);

    const membership = (
      await h.db.select().from(campaignMemberships).where(eq(campaignMemberships.contactId, prospect.id))
    )[0]!;
    expect(membership.status).toBe('PAUSED');
    expect(membership.stoppedReason).toMatch(/\{\{company\}\}|\{\{personalization_hook\}\}/);
  });

  it('refuses to enrol a suppressed number', async () => {
    const prospect = await createProspect(h.ctx, {
      phone: '4165550207',
      firstName: 'Chris',
      company: { name: 'Harbour Roofing', city: 'Oshawa', industry: 'Roofing' },
    });

    await h.db.insert(suppressionEntries).values({
      organizationId: h.ctx.organizationId,
      phone: prospect.phone,
      reason: 'MANUAL',
    });

    const result = await enrollProspects(h.ctx, h.campaignId, [prospect.id]);
    expect(result.enrolled).toBe(0);
    expect(result.skippedSuppressed).toBe(1);
  });

  it('keeps a prospect in the same experiment arm across runs', () => {
    const variants = [
      { id: 'a', active: true, weight: 1 },
      { id: 'b', active: true, weight: 1 },
      { id: 'c', active: true, weight: 1 },
    ] as never[];

    const first = pickVariant(variants, 'contact-1:step-1');
    for (let i = 0; i < 20; i += 1) {
      expect(pickVariant(variants, 'contact-1:step-1')).toBe(first);
    }
    // Different prospects still spread across the arms.
    const chosen = new Set(
      Array.from({ length: 30 }, (_, i) => pickVariant(variants, `contact-${i}:step-1`)?.id),
    );
    expect(chosen.size).toBeGreaterThan(1);
  });

  it('creates a prospect from an inbound message from an unknown number', async () => {
    const outcome = await handleInboundMessage(
      h.ctx.organizationId,
      inboundWebhook('+14165559999', SENDING_NUMBER, 'saw your text, tell me more'),
      'mock',
    );
    expect(outcome.handled).toBe(true);

    const created = (
      await h.db.select().from(contacts).where(eq(contacts.phone, '+14165559999'))
    )[0]!;
    expect(created.source).toBe('inbound_sms');
    expect(created.status).toBe('REPLIED');
  });
});
