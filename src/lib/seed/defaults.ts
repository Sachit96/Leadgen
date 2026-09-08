import { getDb } from '@/lib/db';
import { campaignSteps, campaignVariants, campaigns, knowledgeEntries, objections, phoneNumbers } from '@/lib/db/schema';
import { DEFAULT_PROMPTS } from '@/lib/agents/prompts';
import { savePromptVersion } from '@/lib/agents/prompts';
import { ensureOrgSettings } from '@/lib/services/settings';
import type { Ctx } from '@/lib/auth/context';
import type { AgentType } from '@/lib/db/types';

/**
 * Everything a new organization needs to be immediately usable: the default
 * agent prompts, the On Radar knowledge base, the objection library, and the
 * seeded roofing campaign with its five opening angles.
 *
 * Message copy lives in rows, not in code, so an operator edits it in the app.
 */
export const DEFAULT_KNOWLEDGE = [
  {
    category: 'offer',
    title: 'What On Radar does',
    content:
      'On Radar is an SMS follow-up system for contractors. It re-engages leads and estimates that went cold, holds the conversation by text, qualifies the prospect, and books the appointment into your calendar.',
  },
  {
    category: 'service',
    title: 'What is included',
    content:
      'Setup of the number and messaging, the follow-up sequences, the AI conversation handling, appointment booking, and a shared inbox where your team can take over any conversation at any time.',
  },
  {
    category: 'faq',
    title: 'How long does setup take',
    content: 'Typically a few days from kickoff to the first messages going out.',
  },
  {
    category: 'faq',
    title: 'Do we keep control',
    content:
      'Yes. Every conversation is visible in the inbox, you can take over mid-conversation, and you can pause the whole system at any time.',
  },
  {
    category: 'faq',
    title: 'Where do the leads come from',
    content:
      'On Radar works your existing leads and old estimates first. It is a follow-up system, not a lead-buying service.',
  },
  {
    category: 'sales_rule',
    title: 'Never quote outside settings',
    content:
      'Setup and monthly pricing come from settings. Never quote a different figure, never imply a discount, and never state a contract length.',
  },
  {
    category: 'sales_rule',
    title: 'Discovery before pitch',
    content:
      'Do not describe the product until the prospect has told you how they currently handle follow-up. The problem has to be theirs before the solution means anything.',
  },
];

export const DEFAULT_OBJECTIONS = [
  {
    trigger: 'How much?',
    matchers: ['how much', 'price', 'cost', 'pricing'],
    strategy:
      'Give the real number from settings without hedging, then immediately tie it to their own figures — one recovered job usually covers it. Do not apologise for the price.',
    exampleResponses: [
      'Setup is a one-time fee and then a flat monthly. Depends what a job is worth to you — what does an average one run?',
    ],
  },
  {
    trigger: 'How does it work?',
    matchers: ['how does it work', 'what is it', 'explain'],
    strategy:
      'One sentence, mechanism not features, then hand the question back so it stays a conversation.',
    exampleResponses: ['We text your old leads and estimates, handle the back and forth, and book the ones that are still interested. How many of those are sitting in your system?'],
  },
  {
    trigger: 'We already have a CRM.',
    matchers: ['already have a crm', 'we use', 'we have software'],
    strategy:
      'Agree, then separate storage from follow-up. A CRM records the lead; it does not chase it. Ask what actually happens after an estimate goes out.',
    exampleResponses: ['Makes sense. Does it actually do the following up, or is that still on someone there?'],
  },
  {
    trigger: 'We already follow up.',
    matchers: ['we follow up', 'we call them', 'we already do'],
    strategy:
      'Do not argue. Ask how long they keep following up. Almost everyone stops at a week; the answer opens the gap on its own.',
    exampleResponses: ['Good — how long do you usually keep at one before you let it go?'],
  },
  {
    trigger: 'Send me some information.',
    matchers: ['send me info', 'send information', 'email me', 'send details'],
    strategy:
      'A brochure request is usually a soft no. Offer something specific and short instead of a PDF, and keep it to a question.',
    exampleResponses: ['I can, but it is mostly boring. Easier if I show you on a 10-minute call — free tomorrow morning?'],
  },
  {
    trigger: 'Not interested.',
    matchers: ['not interested', 'no thanks', 'pass'],
    strategy:
      'Accept it cleanly and stop. One short, gracious close. Never push a second time after a clear no.',
    exampleResponses: ['No problem at all — thanks for the reply.'],
  },
  {
    trigger: 'Too expensive.',
    matchers: ['too expensive', 'too much', 'cant afford', 'out of budget'],
    strategy:
      'Reframe against the cost of the lost jobs rather than defending the price. Ask what a single job is worth to them.',
    exampleResponses: ['Fair. What does one job bring in for you? That usually decides it either way.'],
  },
  {
    trigger: 'Where did you get my number?',
    matchers: ['where did you get', 'how did you get my number', 'who gave you'],
    strategy:
      'Answer honestly and briefly — public business listing — apologise if unwanted, and offer to stop. Never be evasive about this.',
    exampleResponses: ['Your business listing. Happy to leave you alone if this is not useful — just say the word.'],
  },
  {
    trigger: "I don't need more leads.",
    matchers: ['dont need more leads', 'do not need leads', 'enough work', 'too busy'],
    strategy:
      'Agree, then pivot: this is not lead generation, it is closing the ones already paid for. Different problem.',
    exampleResponses: ['Not more leads — the ones you already paid for that never closed. Do those get chased?'],
  },
];

/** The seeded campaign: roofing, old-lead recovery, five angles on step one. */
export const ROOFING_CAMPAIGN = {
  name: 'Roofing — Old Lead Recovery',
  description:
    'We help roofing companies recover opportunities from leads and estimates that went cold.',
  industry: 'Roofing',
  messageStrategy:
    'Open with a specific, low-friction question about old estimates. Discovery before pitch. Book only once interest is real.',
};

export const ROOFING_STEPS = [
  {
    name: 'Initial question',
    delayHours: 0,
    stopConditions: ['replied'],
    variants: [
      {
        name: 'Lost leads',
        angle: 'lost_leads',
        template:
          '{{first_name}} — quick one about {{company}}. {{personalization_hook}}. Do the leads that never booked just sit there, or does someone chase them?',
      },
      {
        name: 'Old estimates',
        angle: 'old_estimates',
        template:
          'Hi {{first_name}}, question about {{company}} — what happens to the estimates that go out and never close?',
      },
      {
        name: 'Speed to lead',
        angle: 'speed_to_lead',
        template:
          '{{first_name}}, when a new lead comes into {{company}}, roughly how fast does someone get back to them?',
      },
      {
        name: 'Follow-up',
        angle: 'follow_up',
        template:
          'Hi {{first_name}} — how long does {{company}} keep following up on a {{service}} quote before letting it go?',
      },
      {
        name: 'Curiosity',
        angle: 'curiosity',
        template:
          '{{first_name}}, odd question about {{company}}: how many {{service}} you quoted last year never got a second call?',
      },
    ],
  },
  {
    name: 'Follow-up',
    delayHours: 72,
    conditions: ['no_response'],
    stopConditions: ['replied'],
    variants: [
      {
        name: 'Soft bump',
        angle: 'follow_up',
        template: 'Probably caught you mid-job — worth a quick answer when you get a second?',
      },
      {
        name: 'Reframe',
        angle: 'lost_leads',
        template:
          'To be clear {{first_name}}, not selling you leads. Asking about the ones {{company}} already paid for that never closed.',
      },
    ],
  },
  {
    name: 'Pain discovery',
    delayHours: 96,
    conditions: ['no_response'],
    stopConditions: ['replied'],
    variants: [
      {
        name: 'Specific number',
        angle: 'old_estimates',
        template:
          'Most roofers we talk to have 40+ old estimates doing nothing. Is that roughly where {{company}} sits?',
      },
    ],
  },
  {
    name: 'Value message',
    delayHours: 120,
    conditions: ['no_response'],
    stopConditions: ['replied'],
    variants: [
      {
        name: 'Mechanism',
        angle: 'direct_offer',
        template:
          'We text those old estimates back to life and book the ones still interested. Worth 10 minutes to see if it fits {{company}}?',
      },
    ],
  },
  {
    name: 'Close the loop',
    delayHours: 168,
    conditions: ['no_response'],
    stopConditions: ['replied'],
    variants: [
      {
        name: 'Polite close',
        angle: 'curiosity',
        template:
          'Last one from me {{first_name}} — should I close the file, or is this worth a look at some point?',
      },
    ],
  },
];

export async function seedOrganizationDefaults(ctx: Ctx): Promise<{ campaignId: string }> {
  const db = getDb();
  await ensureOrgSettings(ctx.organizationId);

  for (const agentType of Object.keys(DEFAULT_PROMPTS) as AgentType[]) {
    await savePromptVersion(ctx, agentType, DEFAULT_PROMPTS[agentType].prompt, {
      name: DEFAULT_PROMPTS[agentType].name,
      activate: true,
    });
  }

  await db.insert(knowledgeEntries).values(
    DEFAULT_KNOWLEDGE.map((entry, index) => ({
      organizationId: ctx.organizationId,
      category: entry.category,
      title: entry.title,
      content: entry.content,
      position: index,
    })),
  );

  await db.insert(objections).values(
    DEFAULT_OBJECTIONS.map((objection) => ({
      organizationId: ctx.organizationId,
      trigger: objection.trigger,
      matchers: objection.matchers,
      strategy: objection.strategy,
      exampleResponses: objection.exampleResponses,
    })),
  );

  const [number] = await db
    .insert(phoneNumbers)
    .values({
      organizationId: ctx.organizationId,
      number: '+15550001111',
      label: 'Primary sending number',
      dailyCap: 200,
    })
    .onConflictDoNothing()
    .returning();

  const [campaign] = await db
    .insert(campaigns)
    .values({
      organizationId: ctx.organizationId,
      name: ROOFING_CAMPAIGN.name,
      description: ROOFING_CAMPAIGN.description,
      industry: ROOFING_CAMPAIGN.industry,
      messageStrategy: ROOFING_CAMPAIGN.messageStrategy,
      status: 'DRAFT',
      dailyCapacity: 50,
      timezone: ctx.timezone,
      fromPhoneNumberId: number?.id ?? null,
    })
    .returning();

  for (const [index, step] of ROOFING_STEPS.entries()) {
    const [created] = await db
      .insert(campaignSteps)
      .values({
        organizationId: ctx.organizationId,
        campaignId: campaign!.id,
        position: index + 1,
        name: step.name,
        delayHours: step.delayHours,
        conditions: step.conditions ?? [],
        stopConditions: step.stopConditions,
      })
      .returning();

    await db.insert(campaignVariants).values(
      step.variants.map((variant) => ({
        organizationId: ctx.organizationId,
        campaignId: campaign!.id,
        stepId: created!.id,
        name: variant.name,
        angle: variant.angle,
        template: variant.template,
        weight: 1,
      })),
    );
  }

  return { campaignId: campaign!.id };
}
