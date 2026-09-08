import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { conversations } from '@/lib/db/schema';
import { logger } from '@/lib/core/logger';
import { detectHandoffSignal } from '@/lib/core/intent';
import { segmentInfo } from '@/lib/core/template';
import {
  getConversation,
  setLeadTemperature,
  triggerHandoff,
} from '@/lib/services/conversations';
import {
  aiReplyIdempotencyKey,
  listMessages,
  queueOutbound,
} from '@/lib/services/messages';
import { buildKnowledgeBlock } from '@/lib/services/knowledge';
import { buildPersonalizationContext } from '@/lib/services/personalization';
import {
  applyQualification,
  DEFAULT_QUALIFICATION_FIELDS,
  describeQualification,
  getQualification,
  nextQuestion,
  parseFields,
} from '@/lib/services/qualification';
import { getOrgConfig } from '@/lib/services/settings';
import { recordActivity } from '@/lib/services/activity';
import { advanceProspectStatus } from '@/lib/services/contacts';
import { notify } from '@/lib/services/notifications';
import type { Ctx } from '@/lib/auth/context';
import { resolvePrompt } from './prompts';
import { runAgent } from './runner';
import { salesTurnSchema, type SalesTurn } from './schemas';

export type SalesTurnOutcome =
  | { result: 'replied'; messageId: string; turn: SalesTurn }
  | { result: 'handoff'; reason: string }
  | { result: 'skipped'; reason: string }
  | { result: 'failed'; error: string };

/**
 * One turn of the AI SDR.
 *
 * The agent is stateful: it receives the conversation's current state, the full
 * transcript, verified company facts, the qualification captured so far, and
 * the knowledge base — then returns a structured turn that updates all of them.
 *
 * The model does not get to decide unilaterally that a message goes out. Its
 * output is validated, checked for handoff signals, and only then queued.
 */
export async function runSalesTurn(
  ctx: Ctx,
  conversationId: string,
): Promise<SalesTurnOutcome> {
  const log = logger.child({ organizationId: ctx.organizationId, conversationId });
  const { conversation, contact, company } = await getConversation(ctx, conversationId);

  if (!conversation.aiEnabled) return { result: 'skipped', reason: conversation.aiPausedReason ?? 'AI is paused' };
  if (conversation.requiresHuman) return { result: 'skipped', reason: 'waiting on a human' };
  if (contact.status === 'DO_NOT_CONTACT') return { result: 'skipped', reason: 'do-not-contact' };

  const config = await getOrgConfig(ctx);
  if (!config.ai.enabled) return { result: 'skipped', reason: 'AI is disabled for this organization' };

  const transcript = await listMessages(ctx, conversationId);
  const inbound = [...transcript].reverse().find((m) => m.direction === 'INBOUND');
  if (!inbound) return { result: 'skipped', reason: 'nothing to respond to yet' };

  // Already answered this inbound — the queue's idempotency key would catch it,
  // but checking here avoids a pointless model call.
  const answered = transcript.some(
    (m) => m.direction === 'OUTBOUND' && m.author === 'AI' && m.createdAt > inbound.createdAt,
  );
  if (answered) return { result: 'skipped', reason: 'already replied to the latest message' };

  const aiTurns = transcript.filter((m) => m.author === 'AI').length;
  if (aiTurns >= config.ai.maxAiTurnsPerConversation) {
    await triggerHandoff(ctx, conversationId, 'AI turn limit reached without booking');
    return { result: 'handoff', reason: 'AI turn limit reached without booking' };
  }

  const deterministicSignal = detectHandoffSignal(inbound.body);
  if (deterministicSignal) {
    await triggerHandoff(ctx, conversationId, deterministicSignal);
    return { result: 'handoff', reason: deterministicSignal };
  }

  const [personalization, knowledge, qualification, prompt] = await Promise.all([
    buildPersonalizationContext(ctx, contact.id),
    buildKnowledgeBlock(ctx),
    getQualification(ctx, conversationId),
    resolvePrompt(ctx, 'sales'),
  ]);

  const fields = parseFields(qualification?.fields);
  const target = nextQuestion(fields);

  const system = [
    prompt.prompt
      .replace('{{agent_name}}', config.ai.agentName)
      .replace('{{company_name}}', config.offer.companyName)
      .replace(
        '{{disclosure_rule}}',
        config.ai.discloseAiWhenAsked
          ? 'If asked whether you are a bot or an AI, say plainly that you are an assistant working with the team, and set requires_human to true.'
          : 'If asked whether you are a bot, do not claim to be a person. Set requires_human to true and let a human answer.',
      ),
    '',
    knowledge,
    '',
    'VERIFIED FACTS — the only things you know about this business:',
    personalization.facts.length > 0 ? personalization.facts.map((f) => `- ${f}`).join('\n') : '- Nothing has been researched about this business.',
    '',
    'UNKNOWN — you do not know these. Never assert or imply them:',
    personalization.unknowns.length > 0 ? personalization.unknowns.map((u) => `- ${u}`).join('\n') : '- (nothing)',
    '',
    'QUALIFICATION FIELDS you are trying to learn, in priority order:',
    DEFAULT_QUALIFICATION_FIELDS.map((f) => `- ${f.key} (${f.label}): ${f.question}`).join('\n'),
    '',
    'ALREADY CAPTURED:',
    describeQualification(fields),
    '',
    target ? `NEXT THING TO LEARN: ${target.key} — ${target.question}` : 'All required qualification fields are captured. Move toward booking a call.',
    '',
    `CURRENT CONVERSATION STATE: ${conversation.state}`,
    `Keep the reply under 320 characters.`,
  ].join('\n');

  const messages = transcript.map((message) => ({
    role: (message.direction === 'INBOUND' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: message.body,
  }));

  // Cheap model for a straightforward reply; strong model once the prospect is
  // engaged, objecting, or close to booking.
  const tier = pickTier(conversation.state, transcript.length);

  const result = await runAgent(ctx, {
    agentType: 'sales',
    schema: salesTurnSchema,
    system,
    promptVersion: prompt.version,
    messages,
    tier,
    maxTokens: 700,
    temperature: 0.75,
    conversationId,
    contactId: contact.id,
  });

  if (!result.ok) {
    // AI failure never produces random text and never silently stalls: flag it,
    // notify, and leave the conversation fully answerable by a human.
    await getDb()
      .update(conversations)
      .set({
        requiresHuman: true,
        handoffReason: `AI failed: ${result.code}`,
        aiEnabled: false,
        aiPausedReason: `AI failed: ${result.code}`,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));

    await recordActivity(ctx, {
      type: 'ai_failed',
      title: 'AI could not produce a valid reply',
      body: result.error,
      contactId: contact.id,
      conversationId,
      metadata: { code: result.code, promptVersion: result.promptVersion },
    });

    await notify(ctx, {
      type: 'ai_failure',
      title: `AI could not reply to ${company?.name ?? contact.phone}`,
      body: 'The conversation is waiting for a manual response.',
      link: `/inbox/${conversationId}`,
    });

    log.error('sales turn failed', { errorCode: result.code });
    return { result: 'failed', error: result.error };
  }

  const turn = result.output;

  if (turn.requires_human || turn.confidence < config.ai.handoffConfidenceThreshold) {
    const reason =
      turn.handoff_reason ??
      (turn.confidence < config.ai.handoffConfidenceThreshold
        ? `Low confidence (${turn.confidence.toFixed(2)})`
        : 'Agent requested a human');
    await applyTurnState(ctx, conversationId, contact.id, turn, { skipMessage: true });
    await triggerHandoff(ctx, conversationId, reason);
    return { result: 'handoff', reason };
  }

  const body = turn.message.trim();
  if (segmentInfo(body).characters > 480) {
    await triggerHandoff(ctx, conversationId, 'Generated reply was too long to send as SMS');
    return { result: 'handoff', reason: 'reply too long' };
  }

  const message = await queueOutbound(ctx, {
    conversationId,
    body,
    author: 'AI',
    idempotencyKey: aiReplyIdempotencyKey(conversationId, inbound.id),
    campaignId: conversation.campaignId,
    promptVersion: result.promptVersion,
  });

  await applyTurnState(ctx, conversationId, contact.id, turn, { skipMessage: false });

  await recordActivity(ctx, {
    type: 'ai_response',
    title: `AI replied (${turn.conversation_state})`,
    body,
    contactId: contact.id,
    conversationId,
    metadata: {
      intent: turn.intent,
      confidence: turn.confidence,
      nextAction: turn.next_action,
      promptVersion: result.promptVersion,
      model: result.model,
    },
  });

  log.info('sales turn completed', {
    result: 'replied',
    latencyMs: result.latencyMs,
    state: turn.conversation_state,
  });

  return { result: 'replied', messageId: message.id, turn };
}

/** Applies everything the turn changed apart from the outgoing message. */
async function applyTurnState(
  ctx: Ctx,
  conversationId: string,
  contactId: string,
  turn: SalesTurn,
  options: { skipMessage: boolean },
): Promise<void> {
  if (Object.keys(turn.qualification_updates).length > 0) {
    await applyQualification(ctx, {
      conversationId,
      contactId,
      updates: turn.qualification_updates,
      source: 'ai',
      confidence: turn.confidence,
    });
  }

  const followUpAt =
    !options.skipMessage && turn.follow_up_in_minutes
      ? new Date(Date.now() + turn.follow_up_in_minutes * 60_000)
      : null;

  await getDb()
    .update(conversations)
    .set({
      state: turn.conversation_state,
      intent: turn.intent,
      leadTemperature: turn.lead_temperature,
      nextFollowUpAt: followUpAt,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));

  await setLeadTemperature(ctx, conversationId, turn.lead_temperature);

  if (turn.conversation_state === 'QUALIFICATION' || turn.conversation_state === 'VALUE') {
    await advanceProspectStatus(ctx, contactId, 'QUALIFIED');
  }
  if (turn.conversation_state === 'NOT_INTERESTED') {
    await advanceProspectStatus(ctx, contactId, 'LOST');
  }

  if (turn.lead_temperature === 'hot') {
    await notify(ctx, {
      type: 'hot_lead',
      title: 'A conversation just went hot',
      body: turn.message.slice(0, 160),
      link: `/inbox/${conversationId}`,
    });
  }
}

/** Cost control: the cheap model handles the easy turns. */
function pickTier(state: string, messageCount: number): 'fast' | 'smart' {
  const demanding = ['OBJECTION', 'VALUE', 'QUALIFICATION', 'APPOINTMENT', 'PAIN'];
  if (demanding.includes(state)) return 'smart';
  if (messageCount > 6) return 'smart';
  return 'fast';
}
