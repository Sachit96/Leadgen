'use server';

import { requireCtx } from '@/lib/auth/context';
import { invalid } from '@/lib/core/errors';
import { summarizeConversation } from '@/lib/agents/summary';
import { runSalesTurn } from '@/lib/agents/sales';
import {
  assignConversation,
  markRead,
  setAiEnabled,
  setConversationState,
  takeOverConversation,
} from '@/lib/services/conversations';
import { manualIdempotencyKey, queueOutbound } from '@/lib/services/messages';
import { suppress } from '@/lib/services/suppression';
import { applyQualification } from '@/lib/services/qualification';
import { advanceProspectStatus } from '@/lib/services/contacts';
import { tick } from '@/lib/worker/tick';
import type { ConversationState } from '@/lib/db/types';
import { action, optionalStr, str } from './helpers';

/**
 * Sends a message a human typed.
 *
 * It still goes through the queue rather than straight to the provider, so a
 * manual send gets the same guardrails, retries and delivery tracking as an
 * automated one. The worker tick that follows just makes the UI feel immediate.
 */
export async function sendManualMessage(form: FormData) {
  return action('conversation.send', async () => {
    const ctx = await requireCtx('message:send');
    const conversationId = str(form, 'conversationId');
    const body = str(form, 'body');
    if (!body) throw invalid('Write a message first');

    const message = await queueOutbound(ctx, {
      conversationId,
      body,
      author: 'HUMAN',
      idempotencyKey: manualIdempotencyKey(conversationId, body, ctx.userId),
    });

    await tick({ sequenceBatch: 0, aiBatch: 0, sendBatch: 5, skipMaintenance: true });
    return { messageId: message.id };
  }, ['/inbox']);
}

export async function pauseAi(conversationId: string, reason?: string) {
  return action('conversation.pauseAi', async () => {
    const ctx = await requireCtx('conversation:write');
    await setAiEnabled(ctx, conversationId, false, reason ?? 'paused by operator');
  }, ['/inbox']);
}

export async function resumeAi(conversationId: string) {
  return action('conversation.resumeAi', async () => {
    const ctx = await requireCtx('conversation:write');
    await setAiEnabled(ctx, conversationId, true);
  }, ['/inbox']);
}

export async function takeOver(conversationId: string) {
  return action('conversation.takeOver', async () => {
    const ctx = await requireCtx('conversation:write');
    await takeOverConversation(ctx, conversationId);
  }, ['/inbox']);
}

export async function assign(conversationId: string, userId: string | null) {
  return action('conversation.assign', async () => {
    const ctx = await requireCtx('conversation:write');
    await assignConversation(ctx, conversationId, userId);
  }, ['/inbox']);
}

export async function changeState(conversationId: string, state: ConversationState) {
  return action('conversation.changeState', async () => {
    const ctx = await requireCtx('conversation:write');
    await setConversationState(ctx, conversationId, state, { reason: 'changed by operator' });
  }, ['/inbox', '/pipeline']);
}

export async function markConversationRead(conversationId: string) {
  return action('conversation.markRead', async () => {
    const ctx = await requireCtx();
    await markRead(ctx, conversationId);
  }, []);
}

export async function markQualified(conversationId: string, contactId: string) {
  return action('conversation.markQualified', async () => {
    const ctx = await requireCtx('conversation:write');
    await setConversationState(ctx, conversationId, 'QUALIFICATION', { reason: 'marked by operator' });
    await advanceProspectStatus(ctx, contactId, 'QUALIFIED');
  }, ['/inbox', '/prospects', '/pipeline']);
}

/** Asks the AI to draft and send the next turn now, instead of on the next tick. */
export async function runAiNow(conversationId: string) {
  return action('conversation.runAi', async () => {
    const ctx = await requireCtx('conversation:write');
    const outcome = await runSalesTurn(ctx, conversationId);
    if (outcome.result === 'failed') throw invalid(`The AI could not reply: ${outcome.error}`);
    if (outcome.result === 'skipped') throw invalid(outcome.reason);
    await tick({ sequenceBatch: 0, aiBatch: 0, sendBatch: 5, skipMaintenance: true });
    return outcome;
  }, ['/inbox']);
}

export async function generateSummary(conversationId: string) {
  return action('conversation.summarize', async () => {
    const ctx = await requireCtx('conversation:write');
    const outcome = await summarizeConversation(ctx, conversationId);
    if (outcome.result === 'failed') throw invalid(`Could not summarize: ${outcome.error}`);
    if (outcome.result === 'skipped') throw invalid(outcome.reason);
    return outcome.output;
  }, ['/inbox']);
}

export async function saveQualification(form: FormData) {
  return action('conversation.qualification', async () => {
    const ctx = await requireCtx('conversation:write');
    const conversationId = str(form, 'conversationId');
    const contactId = str(form, 'contactId');

    const updates: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (!key.startsWith('q_') || typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed) updates[key.slice(2)] = trimmed;
    }

    await applyQualification(ctx, { conversationId, contactId, updates, source: 'human' });
  }, ['/inbox']);
}

export async function suppressContact(form: FormData) {
  return action('conversation.suppress', async () => {
    const ctx = await requireCtx('suppression:write');
    await suppress(ctx, {
      phone: str(form, 'phone'),
      reason: 'MANUAL',
      note: optionalStr(form, 'note'),
      contactId: optionalStr(form, 'contactId'),
    });
  }, ['/inbox', '/prospects']);
}
