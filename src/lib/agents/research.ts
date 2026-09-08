import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { companies } from '@/lib/db/schema';
import { getCompany } from '@/lib/services/companies';
import { rescoreProspect } from '@/lib/services/contacts';
import { recordActivity } from '@/lib/services/activity';
import type { Ctx } from '@/lib/auth/context';
import { resolvePrompt } from './prompts';
import { runAgent } from './runner';
import { researchSchema, type ResearchOutput } from './schemas';

const CACHE_DAYS = 30;

export type ResearchOutcome =
  | { result: 'researched'; output: ResearchOutput }
  | { result: 'cached'; researchedAt: Date }
  | { result: 'failed'; error: string };

/**
 * Enriches a company from the structured data we hold.
 *
 * Results are cached for 30 days: research is the most expensive AI call in the
 * system and a contractor's public profile does not change weekly. Anything the
 * model could not establish is stored as an explicit unknown rather than being
 * quietly filled in.
 */
export async function researchCompany(
  ctx: Ctx,
  companyId: string,
  options: { force?: boolean; contactId?: string } = {},
): Promise<ResearchOutcome> {
  const company = await getCompany(ctx, companyId);

  if (!options.force && company.researchedAt) {
    const age = Date.now() - company.researchedAt.getTime();
    if (age < CACHE_DAYS * 24 * 60 * 60_000) {
      return { result: 'cached', researchedAt: company.researchedAt };
    }
  }

  const prompt = await resolvePrompt(ctx, 'research');

  const known = [
    `Name: ${company.name}`,
    line('Website', company.website),
    line('Industry', company.industry),
    line('City', company.city),
    line('Province', company.province),
    line('Google reviews', company.googleReviews),
    line('Google rating', company.googleRating),
    line('Owner', company.ownerName),
    line('Estimated size', company.estimatedCompanySize),
    line('Website quality', company.websiteQuality),
    line('Running ads', company.adPresence),
    line('Booking system', company.bookingSystemDetected),
    line('CRM detected', company.crmDetected),
    line('Facebook', company.facebookUrl),
    line('Instagram', company.instagramUrl),
    line('LinkedIn', company.linkedinUrl),
    line('Notes', company.researchNotes),
  ]
    .filter(Boolean)
    .join('\n');

  const result = await runAgent(ctx, {
    agentType: 'research',
    schema: researchSchema,
    system: prompt.prompt,
    promptVersion: prompt.version,
    messages: [
      {
        role: 'user',
        content: `Here is everything on file for this business. Anything not listed is unknown.\n\n${known}`,
      },
    ],
    // Research runs once per company and feeds every later message, so it is
    // worth the stronger model.
    tier: 'smart',
    maxTokens: 900,
    temperature: 0.3,
    contactId: options.contactId ?? null,
  });

  if (!result.ok) return { result: 'failed', error: result.error };

  const output = result.output;
  const hooks = output.personalization_hook ? [output.personalization_hook] : [];

  await getDb()
    .update(companies)
    .set({
      researchSummary: output.summary,
      researchPainPoints: output.pain_points,
      researchOutreachAngle: output.outreach_angle,
      researchConfidence: output.confidence,
      personalizationHooks: hooks,
      researchedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(companies.id, companyId));

  await recordActivity(ctx, {
    type: 'research_completed',
    title: `Research completed for ${company.name}`,
    body: output.summary,
    contactId: options.contactId ?? null,
    metadata: {
      confidence: output.confidence,
      unknowns: output.unknowns,
      promptVersion: result.promptVersion,
    },
  });

  if (options.contactId) await rescoreProspect(ctx, options.contactId);

  return { result: 'researched', output };
}

function line(label: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return `${label}: ${String(value)}`;
}
