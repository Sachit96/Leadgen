'use server';

import { requireCtx } from '@/lib/auth/context';
import { invalid } from '@/lib/core/errors';
import { researchCompany } from '@/lib/agents/research';
import { generateOutreachMessage } from '@/lib/agents/outreach';
import {
  assignOwner,
  createProspect,
  deleteProspects,
  getProspect,
  rescoreMany,
  rescoreProspect,
  setProspectStatus,
  updateProspect,
} from '@/lib/services/contacts';
import { updateCompany } from '@/lib/services/companies';
import { enrollProspects } from '@/lib/services/campaigns';
import { commitImport, previewImport } from '@/lib/services/import';
import type { ProspectStatus } from '@/lib/db/types';
import { action, bool, list, optionalNum, optionalStr, str } from './helpers';

export async function createProspectAction(form: FormData) {
  return action('prospect.create', async () => {
    const ctx = await requireCtx('prospect:write');
    const companyName = optionalStr(form, 'companyName');
    const prospect = await createProspect(ctx, {
      firstName: optionalStr(form, 'firstName'),
      lastName: optionalStr(form, 'lastName'),
      phone: str(form, 'phone'),
      email: optionalStr(form, 'email'),
      title: optionalStr(form, 'title'),
      source: 'manual',
      company: companyName
        ? {
            name: companyName,
            website: optionalStr(form, 'website'),
            industry: optionalStr(form, 'industry'),
            city: optionalStr(form, 'city'),
            province: optionalStr(form, 'province'),
            googleReviews: optionalNum(form, 'googleReviews'),
            googleRating: optionalNum(form, 'googleRating'),
            ownerName: optionalStr(form, 'ownerName'),
          }
        : null,
    });
    return { id: prospect.id };
  }, ['/prospects', '/']);
}

export async function updateProspectAction(form: FormData) {
  return action('prospect.update', async () => {
    const ctx = await requireCtx('prospect:write');
    const id = str(form, 'id');
    await updateProspect(ctx, id, {
      firstName: optionalStr(form, 'firstName'),
      lastName: optionalStr(form, 'lastName'),
      phone: str(form, 'phone'),
      email: optionalStr(form, 'email'),
      title: optionalStr(form, 'title'),
    });

    const companyId = optionalStr(form, 'companyId');
    if (companyId) {
      await updateCompany(ctx, companyId, {
        name: str(form, 'companyName'),
        website: optionalStr(form, 'website'),
        industry: optionalStr(form, 'industry'),
        city: optionalStr(form, 'city'),
        province: optionalStr(form, 'province'),
        googleReviews: optionalNum(form, 'googleReviews'),
        googleRating: optionalNum(form, 'googleRating'),
        ownerName: optionalStr(form, 'ownerName'),
        estimatedCompanySize: optionalStr(form, 'estimatedCompanySize'),
        websiteQuality: optionalStr(form, 'websiteQuality'),
        crmDetected: optionalStr(form, 'crmDetected'),
        adPresence: form.get('adPresence') === '' ? null : bool(form, 'adPresence'),
        bookingSystemDetected:
          form.get('bookingSystemDetected') === '' ? null : bool(form, 'bookingSystemDetected'),
      });
      await rescoreProspect(ctx, id);
    }
  }, ['/prospects']);
}

export async function setStatusAction(id: string, status: ProspectStatus) {
  return action('prospect.setStatus', async () => {
    const ctx = await requireCtx('prospect:write');
    await setProspectStatus(ctx, id, status);
  }, ['/prospects', '/pipeline']);
}

export async function bulkAssignCampaign(form: FormData) {
  return action('prospect.bulkEnroll', async () => {
    const ctx = await requireCtx('campaign:write');
    const campaignId = str(form, 'campaignId');
    const ids = list(form, 'ids');
    if (!campaignId) throw invalid('Pick a campaign first');
    if (ids.length === 0) throw invalid('Select at least one prospect');
    return enrollProspects(ctx, campaignId, ids);
  }, ['/prospects', '/campaigns']);
}

export async function bulkRescore(form: FormData) {
  return action('prospect.bulkRescore', async () => {
    const ctx = await requireCtx('prospect:write');
    const ids = list(form, 'ids');
    if (ids.length === 0) throw invalid('Select at least one prospect');
    return { rescored: await rescoreMany(ctx, ids) };
  }, ['/prospects']);
}

export async function bulkAssignOwner(form: FormData) {
  return action('prospect.bulkOwner', async () => {
    const ctx = await requireCtx('prospect:write');
    const ownerUserId = optionalStr(form, 'ownerUserId');
    return { updated: await assignOwner(ctx, list(form, 'ids'), ownerUserId) };
  }, ['/prospects']);
}

export async function bulkDelete(form: FormData) {
  return action('prospect.bulkDelete', async () => {
    const ctx = await requireCtx('prospect:write');
    const ids = list(form, 'ids');
    if (ids.length === 0) throw invalid('Select at least one prospect');
    return { deleted: await deleteProspects(ctx, ids) };
  }, ['/prospects']);
}

export async function researchProspect(contactId: string) {
  return action('prospect.research', async () => {
    const ctx = await requireCtx('prospect:write');
    const { contact } = await getProspect(ctx, contactId);
    if (!contact.companyId) throw invalid('Add a company to this prospect before researching');

    const outcome = await researchCompany(ctx, contact.companyId, { force: true, contactId });
    if (outcome.result === 'failed') throw invalid(`Research failed: ${outcome.error}`);
    return outcome;
  }, ['/prospects']);
}

export async function generateMessagePreview(contactId: string, angle?: string) {
  return action('prospect.generateMessage', async () => {
    const ctx = await requireCtx('message:send');
    const outcome = await generateOutreachMessage(ctx, contactId, { angle });
    if (outcome.result === 'failed') throw invalid(outcome.error);
    return { message: outcome.message, rationale: outcome.rationale };
  }, []);
}

export async function previewImportAction(form: FormData) {
  return action('prospect.previewImport', async () => {
    const ctx = await requireCtx('prospect:import');
    const csv = str(form, 'csv');
    if (!csv) throw invalid('Paste or upload a CSV first');
    const preview = await previewImport(ctx, csv);
    // Only the first 50 rows travel back to the browser; the rest are counted.
    return { ...preview, rows: preview.rows.slice(0, 50) };
  }, []);
}

export async function commitImportAction(form: FormData) {
  return action('prospect.commitImport', async () => {
    const ctx = await requireCtx('prospect:import');
    const csv = str(form, 'csv');
    if (!csv) throw invalid('Nothing to import');

    const result = await commitImport(ctx, csv, {
      filename: str(form, 'filename') || 'import.csv',
      updateExisting: bool(form, 'updateExisting'),
    });

    const campaignId = optionalStr(form, 'campaignId');
    if (campaignId && result.contactIds.length > 0) {
      await enrollProspects(ctx, campaignId, result.contactIds);
    }

    return result;
  }, ['/prospects', '/campaigns', '/']);
}
