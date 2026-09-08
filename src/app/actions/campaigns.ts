'use server';

import { requireCtx } from '@/lib/auth/context';
import { invalid } from '@/lib/core/errors';
import {
  createCampaign,
  createStep,
  createVariant,
  deleteStep,
  deleteVariant,
  enrollByFilter,
  removeFromCampaign,
  reorderSteps,
  setCampaignStatus,
  updateCampaign,
  updateStep,
  updateVariant,
  validateTemplate,
} from '@/lib/services/campaigns';
import { tick } from '@/lib/worker/tick';
import type { CampaignStatus, ProspectStatus } from '@/lib/db/types';
import { action, bool, list, num, optionalNum, optionalStr, str } from './helpers';

export async function createCampaignAction(form: FormData) {
  return action('campaign.create', async () => {
    const ctx = await requireCtx('campaign:write');
    const campaign = await createCampaign(ctx, {
      name: str(form, 'name'),
      description: optionalStr(form, 'description'),
      industry: optionalStr(form, 'industry'),
      messageStrategy: optionalStr(form, 'messageStrategy'),
      dailyCapacity: num(form, 'dailyCapacity', 50),
      minScore: optionalNum(form, 'minScore'),
    });
    return { id: campaign.id };
  }, ['/campaigns']);
}

export async function updateCampaignAction(form: FormData) {
  return action('campaign.update', async () => {
    const ctx = await requireCtx('campaign:write');
    await updateCampaign(ctx, str(form, 'id'), {
      name: str(form, 'name'),
      description: optionalStr(form, 'description'),
      industry: optionalStr(form, 'industry'),
      messageStrategy: optionalStr(form, 'messageStrategy'),
      dailyCapacity: num(form, 'dailyCapacity', 50),
      sendingWindowStart: str(form, 'sendingWindowStart') || '09:00',
      sendingWindowEnd: str(form, 'sendingWindowEnd') || '19:00',
      sendingDays: list(form, 'sendingDays').map(Number),
      timezone: str(form, 'timezone') || ctx.timezone,
      minScore: optionalNum(form, 'minScore'),
    });
  }, ['/campaigns']);
}

export async function setCampaignStatusAction(id: string, status: CampaignStatus) {
  return action('campaign.setStatus', async () => {
    const ctx = await requireCtx(status === 'ACTIVE' ? 'campaign:launch' : 'campaign:write');
    await setCampaignStatus(ctx, id, status);
    // Give an activated campaign an immediate first pass so the operator sees
    // it working rather than waiting for the next tick.
    if (status === 'ACTIVE') await tick({ aiBatch: 0, skipMaintenance: true });
  }, ['/campaigns', '/']);
}

export async function createStepAction(form: FormData) {
  return action('campaign.createStep', async () => {
    const ctx = await requireCtx('campaign:write');
    const step = await createStep(ctx, str(form, 'campaignId'), {
      name: str(form, 'name') || 'New step',
      delayHours: num(form, 'delayHours', 48),
      useAi: bool(form, 'useAi'),
      conditions: list(form, 'conditions'),
      stopConditions: list(form, 'stopConditions'),
    });
    return { id: step.id };
  }, ['/campaigns']);
}

export async function updateStepAction(form: FormData) {
  return action('campaign.updateStep', async () => {
    const ctx = await requireCtx('campaign:write');
    await updateStep(ctx, str(form, 'stepId'), {
      name: str(form, 'name'),
      delayHours: num(form, 'delayHours', 48),
      useAi: bool(form, 'useAi'),
      conditions: list(form, 'conditions'),
      stopConditions: list(form, 'stopConditions'),
      active: bool(form, 'active'),
    });
  }, ['/campaigns']);
}

export async function deleteStepAction(stepId: string) {
  return action('campaign.deleteStep', async () => {
    const ctx = await requireCtx('campaign:write');
    await deleteStep(ctx, stepId);
  }, ['/campaigns']);
}

export async function reorderStepsAction(campaignId: string, stepIds: string[]) {
  return action('campaign.reorderSteps', async () => {
    const ctx = await requireCtx('campaign:write');
    await reorderSteps(ctx, campaignId, stepIds);
  }, ['/campaigns']);
}

export async function createVariantAction(form: FormData) {
  return action('campaign.createVariant', async () => {
    const ctx = await requireCtx('campaign:write');
    await createVariant(ctx, str(form, 'campaignId'), str(form, 'stepId'), {
      name: str(form, 'name') || 'New variant',
      angle: str(form, 'angle') || 'curiosity',
      template: str(form, 'template'),
      weight: num(form, 'weight', 1),
    });
  }, ['/campaigns']);
}

export async function updateVariantAction(form: FormData) {
  return action('campaign.updateVariant', async () => {
    const ctx = await requireCtx('campaign:write');
    await updateVariant(ctx, str(form, 'variantId'), {
      name: str(form, 'name'),
      angle: str(form, 'angle'),
      template: str(form, 'template'),
      weight: num(form, 'weight', 1),
      active: bool(form, 'active'),
    });
  }, ['/campaigns']);
}

export async function deleteVariantAction(variantId: string) {
  return action('campaign.deleteVariant', async () => {
    const ctx = await requireCtx('campaign:write');
    await deleteVariant(ctx, variantId);
  }, ['/campaigns']);
}

/** Validates a template without saving, for the composer's live check. */
export async function validateTemplateAction(template: string) {
  return action('campaign.validateTemplate', async () => {
    await requireCtx('campaign:write');
    validateTemplate(template);
    return { valid: true };
  }, []);
}

export async function enrollByFilterAction(form: FormData) {
  return action('campaign.enrollByFilter', async () => {
    const ctx = await requireCtx('campaign:write');
    const campaignId = str(form, 'campaignId');
    if (!campaignId) throw invalid('Pick a campaign');

    const statuses = list(form, 'status') as ProspectStatus[];
    return enrollByFilter(ctx, campaignId, {
      search: optionalStr(form, 'search') ?? undefined,
      status: statuses.length > 0 ? statuses : undefined,
      bucket: list(form, 'bucket').length > 0 ? list(form, 'bucket') : undefined,
      minScore: optionalNum(form, 'minScore') ?? undefined,
      campaignId: 'none',
    });
  }, ['/campaigns', '/prospects']);
}

export async function removeFromCampaignAction(campaignId: string, contactIds: string[]) {
  return action('campaign.remove', async () => {
    const ctx = await requireCtx('campaign:write');
    return { removed: await removeFromCampaign(ctx, campaignId, contactIds) };
  }, ['/campaigns']);
}

/** Manual "run now" for operators who do not want to wait for the interval. */
export async function runWorkerNow() {
  return action('worker.run', async () => {
    await requireCtx('campaign:launch');
    return tick();
  }, ['/', '/inbox', '/campaigns']);
}
