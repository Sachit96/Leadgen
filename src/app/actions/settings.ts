'use server';

import { requireCtx } from '@/lib/auth/context';
import { invalid } from '@/lib/core/errors';
import { updateOrgConfig } from '@/lib/services/settings';
import { parseScoringConfig, scoringConfigSchema } from '@/lib/core/scoring';
import {
  createKnowledge,
  createObjection,
  deleteKnowledge,
  deleteObjection,
  updateKnowledge,
  updateObjection,
} from '@/lib/services/knowledge';
import { activatePromptVersion, savePromptVersion } from '@/lib/agents/prompts';
import { retryDeadJob } from '@/lib/services/queue';
import { unsuppress } from '@/lib/services/suppression';
import type { AgentType } from '@/lib/db/types';
import { action, bool, list, moneyToCents, num, str } from './helpers';

export async function saveOfferSettings(form: FormData) {
  return action('settings.offer', async () => {
    const ctx = await requireCtx('settings:write');
    await updateOrgConfig(ctx, {
      offer: {
        productName: str(form, 'productName'),
        companyName: str(form, 'companyName'),
        setupCents: moneyToCents(str(form, 'setup')),
        monthlyCents: moneyToCents(str(form, 'monthly')),
        currency: str(form, 'currency') || 'CAD',
        guarantee: str(form, 'guarantee'),
        oneLiner: str(form, 'oneLiner'),
        contractTerms: str(form, 'contractTerms'),
      },
    });
  }, ['/settings', '/ai']);
}

export async function saveSendingSettings(form: FormData) {
  return action('settings.sending', async () => {
    const ctx = await requireCtx('settings:write');
    await updateOrgConfig(ctx, {
      sending: {
        dailyOrgCap: num(form, 'dailyOrgCap', 500),
        contactCooldownMinutes: num(form, 'contactCooldownMinutes', 60),
        maxAutomatedPerContactPerDay: num(form, 'maxAutomatedPerContactPerDay', 2),
        quietHoursStart: str(form, 'quietHoursStart') || '21:00',
        quietHoursEnd: str(form, 'quietHoursEnd') || '09:00',
        sendingDays: list(form, 'sendingDays').map(Number),
        optOutFooter: str(form, 'optOutFooter'),
        includeOptOutFooter: bool(form, 'includeOptOutFooter'),
      },
    });
  }, ['/settings']);
}

export async function saveAiSettings(form: FormData) {
  return action('settings.ai', async () => {
    const ctx = await requireCtx('ai:configure');
    await updateOrgConfig(ctx, {
      ai: {
        enabled: bool(form, 'enabled'),
        autoReply: bool(form, 'autoReply'),
        handoffConfidenceThreshold: num(form, 'handoffConfidenceThreshold', 0.55),
        maxAiTurnsPerConversation: num(form, 'maxAiTurnsPerConversation', 12),
        agentName: str(form, 'agentName') || 'On Radar SDR',
        discloseAiWhenAsked: bool(form, 'discloseAiWhenAsked'),
        requireApprovalForFirstMessage: bool(form, 'requireApprovalForFirstMessage'),
      },
    });
  }, ['/settings', '/ai']);
}

export async function saveScoringSettings(form: FormData) {
  return action('settings.scoring', async () => {
    const ctx = await requireCtx('settings:write');
    const raw = str(form, 'scoring');

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalid('Scoring configuration is not valid JSON');
    }

    const validated = scoringConfigSchema.safeParse(parsed);
    if (!validated.success) {
      throw invalid(`Scoring configuration is invalid: ${validated.error.issues[0]?.message}`);
    }

    await updateOrgConfig(ctx, { scoring: parseScoringConfig(validated.data) });
  }, ['/settings', '/prospects']);
}

export async function savePromptAction(form: FormData) {
  return action('ai.savePrompt', async () => {
    const ctx = await requireCtx('ai:configure');
    const agentType = str(form, 'agentType') as AgentType;
    const prompt = str(form, 'prompt');
    if (!prompt) throw invalid('The prompt cannot be empty');
    const version = await savePromptVersion(ctx, agentType, prompt, { activate: true });
    return { version };
  }, ['/ai']);
}

export async function activatePromptAction(promptId: string) {
  return action('ai.activatePrompt', async () => {
    const ctx = await requireCtx('ai:configure');
    await activatePromptVersion(ctx, promptId);
  }, ['/ai']);
}

export async function createKnowledgeAction(form: FormData) {
  return action('ai.createKnowledge', async () => {
    const ctx = await requireCtx('ai:configure');
    await createKnowledge(ctx, {
      category: str(form, 'category') || 'faq',
      title: str(form, 'title'),
      content: str(form, 'content'),
    });
  }, ['/ai']);
}

export async function updateKnowledgeAction(form: FormData) {
  return action('ai.updateKnowledge', async () => {
    const ctx = await requireCtx('ai:configure');
    await updateKnowledge(ctx, str(form, 'id'), {
      title: str(form, 'title'),
      content: str(form, 'content'),
      category: str(form, 'category'),
    });
  }, ['/ai']);
}

export async function deleteKnowledgeAction(id: string) {
  return action('ai.deleteKnowledge', async () => {
    const ctx = await requireCtx('ai:configure');
    await deleteKnowledge(ctx, id);
  }, ['/ai']);
}

export async function createObjectionAction(form: FormData) {
  return action('ai.createObjection', async () => {
    const ctx = await requireCtx('ai:configure');
    await createObjection(ctx, {
      trigger: str(form, 'trigger'),
      matchers: str(form, 'matchers').split(',').map((m) => m.trim()).filter(Boolean),
      strategy: str(form, 'strategy'),
      exampleResponses: str(form, 'exampleResponses').split('\n').map((r) => r.trim()).filter(Boolean),
    });
  }, ['/ai']);
}

export async function updateObjectionAction(form: FormData) {
  return action('ai.updateObjection', async () => {
    const ctx = await requireCtx('ai:configure');
    await updateObjection(ctx, str(form, 'id'), {
      trigger: str(form, 'trigger'),
      matchers: str(form, 'matchers').split(',').map((m) => m.trim()).filter(Boolean),
      strategy: str(form, 'strategy'),
      exampleResponses: str(form, 'exampleResponses').split('\n').map((r) => r.trim()).filter(Boolean),
    });
  }, ['/ai']);
}

export async function deleteObjectionAction(id: string) {
  return action('ai.deleteObjection', async () => {
    const ctx = await requireCtx('ai:configure');
    await deleteObjection(ctx, id);
  }, ['/ai']);
}

export async function retryDeadJobAction(jobId: string) {
  return action('queue.retry', async () => {
    const ctx = await requireCtx('settings:write');
    await retryDeadJob(ctx, jobId);
  }, ['/settings', '/']);
}

export async function unsuppressAction(phone: string) {
  return action('suppression.remove', async () => {
    const ctx = await requireCtx('suppression:write');
    await unsuppress(ctx, phone);
  }, ['/settings', '/prospects']);
}
