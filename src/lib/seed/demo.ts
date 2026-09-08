import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import {
  appointments,
  companies,
  contacts,
  conversations,
  memberships,
  messages,
  organizations,
  pipelineDeals,
  users,
} from '@/lib/db/schema';
import { hashPassword } from '@/lib/auth/password';
import { systemCtx, type Ctx } from '@/lib/auth/context';
import { rescoreProspect } from '@/lib/services/contacts';
import { applyQualification } from '@/lib/services/qualification';
import { enrollProspects, setCampaignStatus } from '@/lib/services/campaigns';
import { seedOrganizationDefaults } from './defaults';

export type SeedResult = {
  organizationId: string;
  userId: string;
  campaignId: string;
  email: string;
  password: string;
  prospects: number;
};

/**
 * Creates an organization with a real, coherent dataset: researched companies,
 * scored prospects, live conversations with transcripts, a booked appointment
 * and a won deal — so the analytics on first load are computed from real rows
 * rather than hardcoded numbers.
 */
export async function seedDemoData(
  options: {
    email?: string;
    password?: string;
    organizationName?: string;
    withConversations?: boolean;
  } = {},
): Promise<SeedResult> {
  const db = getDb();
  const email = options.email ?? 'owner@onradar.local';
  const password = options.password ?? 'onradar-demo-2026';

  const [organization] = await db
    .insert(organizations)
    .values({
      name: options.organizationName ?? 'On Radar',
      slug: `on-radar-${Date.now().toString(36)}`,
      timezone: 'America/Toronto',
    })
    .returning();

  const [user] = await db
    .insert(users)
    .values({ email, name: 'On Radar Owner', passwordHash: await hashPassword(password) })
    .returning();

  await db
    .insert(memberships)
    .values({ organizationId: organization!.id, userId: user!.id, role: 'OWNER' });

  const ctx: Ctx = {
    organizationId: organization!.id,
    userId: user!.id,
    role: 'OWNER',
    timezone: organization!.timezone,
    user: {
      userId: user!.id,
      organizationId: organization!.id,
      organizationName: organization!.name,
      organizationTimezone: organization!.timezone,
      email,
      name: user!.name,
      role: 'OWNER',
      sessionId: 'seed',
    },
  };

  const { campaignId } = await seedOrganizationDefaults(ctx);

  const contactIds: string[] = [];
  for (const record of DEMO_COMPANIES) {
    const [company] = await db
      .insert(companies)
      .values({
        organizationId: ctx.organizationId,
        name: record.company,
        website: record.website,
        industry: record.industry,
        city: record.city,
        province: 'ON',
        country: 'Canada',
        googleReviews: record.reviews,
        googleRating: record.rating,
        websiteQuality: record.websiteQuality,
        adPresence: record.ads,
        bookingSystemDetected: record.booking,
        crmDetected: record.crm,
        estimatedCompanySize: record.size,
        ownerName: record.owner,
        personalizationHooks: [record.hook],
        researchSummary: record.summary,
        researchPainPoints: record.painPoints,
        researchOutreachAngle: record.angle,
        researchConfidence: 0.75,
        leadGenerationSignals: record.signals,
        researchedAt: new Date(),
      })
      .returning();

    const [contact] = await db
      .insert(contacts)
      .values({
        organizationId: ctx.organizationId,
        companyId: company!.id,
        firstName: record.owner.split(' ')[0]!,
        lastName: record.owner.split(' ').slice(1).join(' ') || null,
        phone: record.phone,
        phoneRaw: record.phone,
        email: record.email,
        title: 'Owner',
        status: 'READY',
        source: 'demo_seed',
        timezone: 'America/Toronto',
        lastActivityAt: new Date(),
      })
      .returning();

    contactIds.push(contact!.id);
    await rescoreProspect(ctx, contact!.id);
  }

  await enrollProspects(ctx, campaignId, contactIds);
  await setCampaignStatus(ctx, campaignId, 'ACTIVE');

  if (options.withConversations !== false) {
    await seedConversations(ctx, campaignId, contactIds);
  }

  return {
    organizationId: organization!.id,
    userId: user!.id,
    campaignId,
    email,
    password,
    prospects: contactIds.length,
  };
}

const HOUR = 60 * 60_000;

async function seedConversations(ctx: Ctx, campaignId: string, contactIds: string[]): Promise<void> {
  const db = getDb();

  for (const [index, script] of DEMO_CONVERSATIONS.entries()) {
    const contactId = contactIds[index];
    if (!contactId) break;

    const [conversation] = await db
      .insert(conversations)
      .values({
        organizationId: ctx.organizationId,
        contactId,
        campaignId,
        state: script.state,
        intent: script.intent,
        leadTemperature: script.temperature,
        aiEnabled: !script.requiresHuman,
        requiresHuman: script.requiresHuman,
        handoffReason: script.handoffReason ?? null,
        aiPausedReason: script.requiresHuman ? script.handoffReason : null,
        unreadCount: script.unread,
      })
      .onConflictDoNothing()
      .returning();

    if (!conversation) continue;

    let clock = Date.now() - script.turns.length * 6 * HOUR;
    for (const turn of script.turns) {
      clock += 3 * HOUR;
      await db.insert(messages).values({
        organizationId: ctx.organizationId,
        conversationId: conversation.id,
        contactId,
        direction: turn.from === 'them' ? 'INBOUND' : 'OUTBOUND',
        author: turn.from === 'them' ? 'PROSPECT' : turn.from === 'human' ? 'HUMAN' : 'AI',
        status: turn.from === 'them' ? 'RECEIVED' : 'DELIVERED',
        body: turn.body,
        campaignId,
        providerKind: 'mock',
        providerMessageId: `SEED-${conversation.id.slice(0, 8)}-${clock}`,
        sentAt: turn.from === 'them' ? null : new Date(clock),
        deliveredAt: turn.from === 'them' ? null : new Date(clock),
        createdAt: new Date(clock),
      });
    }

    await db
      .update(conversations)
      .set({
        lastMessageAt: new Date(clock),
        lastInboundAt: new Date(clock),
        lastOutboundAt: new Date(clock - HOUR),
      })
      .where(eq(conversations.id, conversation.id));

    await db
      .update(contacts)
      .set({ status: script.contactStatus, lastActivityAt: new Date(clock) })
      .where(eq(contacts.id, contactId));

    if (Object.keys(script.qualification).length > 0) {
      await applyQualification(ctx, {
        conversationId: conversation.id,
        contactId,
        updates: script.qualification,
        source: 'ai',
        confidence: 0.8,
      });
    }

    if (script.appointmentInHours !== undefined) {
      const startsAt = new Date(Date.now() + script.appointmentInHours * HOUR);
      const [appointment] = await db
        .insert(appointments)
        .values({
          organizationId: ctx.organizationId,
          contactId,
          conversationId: conversation.id,
          campaignId,
          assignedUserId: ctx.userId,
          title: 'Intro call',
          startsAt,
          endsAt: new Date(startsAt.getTime() + 15 * 60_000),
          timezone: ctx.timezone,
          status: script.appointmentInHours < 0 ? 'COMPLETED' : 'SCHEDULED',
          completedAt: script.appointmentInHours < 0 ? startsAt : null,
        })
        .returning();

      await db.insert(pipelineDeals).values({
        organizationId: ctx.organizationId,
        contactId,
        conversationId: conversation.id,
        campaignId,
        appointmentId: appointment!.id,
        title: `${script.dealTitle} — Booked Jobs System`,
        stage: script.dealStage,
        valueCents: script.dealValueCents,
        recurringValueCents: 20_000,
        ownerUserId: ctx.userId,
        wonAt: script.dealStage === 'WON' ? new Date(Date.now() - 48 * HOUR) : null,
      });
    }
  }
}

const DEMO_COMPANIES = [
  {
    company: 'Summit Ridge Roofing',
    owner: 'Mike Delaney',
    phone: '+14165550142',
    email: 'mike@summitridgeroofing.ca',
    website: 'https://summitridgeroofing.ca',
    industry: 'Roofing',
    city: 'Mississauga',
    reviews: 187,
    rating: 4.7,
    websiteQuality: 'strong',
    ads: true,
    booking: false,
    crm: null,
    size: '12-20',
    hook: "You've clearly built a reputation with Mississauga homeowners",
    summary:
      'Established residential roofer with strong review volume and active paid advertising. No booking system or CRM detected on the site.',
    painPoints: ['Paid leads that go cold after the first callback attempt', 'No system holding old estimates'],
    angle: 'old_estimates',
    signals: ['hiring crew leads'],
  },
  {
    company: 'Northgate Exteriors',
    owner: 'Sandra Whitfield',
    phone: '+19055550188',
    email: 'sandra@northgateexteriors.com',
    website: 'https://northgateexteriors.com',
    industry: 'Roofing',
    city: 'Oakville',
    reviews: 94,
    rating: 4.5,
    websiteQuality: 'adequate',
    ads: true,
    booking: false,
    crm: null,
    size: '6-10',
    hook: "You've been doing Oakville roofs for a long time",
    summary: 'Mid-size roofing and siding contractor advertising actively with no automated follow-up in place.',
    painPoints: ['Estimates going quiet after a week'],
    angle: 'lost_leads',
    signals: [],
  },
  {
    company: 'Trueline Roofing & Siding',
    owner: 'Dev Patel',
    phone: '+16475550119',
    email: 'dev@truelineroofing.ca',
    website: 'https://truelineroofing.ca',
    industry: 'Roofing',
    city: 'Brampton',
    reviews: 231,
    rating: 4.8,
    websiteQuality: 'strong',
    ads: true,
    booking: true,
    crm: 'JobNimbus',
    size: '20+',
    hook: 'Your review count is well ahead of most Brampton roofers',
    summary: 'Large, well-run operation already using JobNimbus and online booking. Lower fit for the core offer.',
    painPoints: ['Speed to lead across a bigger team'],
    angle: 'speed_to_lead',
    signals: ['new location'],
  },
  {
    company: 'Halton Comfort Heating & Air',
    owner: 'Rob Castellano',
    phone: '+12895550166',
    email: 'rob@haltoncomfort.ca',
    website: 'https://haltoncomfort.ca',
    industry: 'HVAC',
    city: 'Burlington',
    reviews: 63,
    rating: 4.4,
    websiteQuality: 'weak',
    ads: false,
    booking: false,
    crm: null,
    size: '3-5',
    hook: "You've built a solid base of Burlington customers",
    summary: 'Small HVAC contractor with a dated site, no advertising and no follow-up tooling.',
    painPoints: ['Quotes handled entirely by phone and memory'],
    angle: 'follow_up',
    signals: [],
  },
  {
    company: 'Riverstone Plumbing',
    owner: 'Aisha Nasser',
    phone: '+14165550177',
    email: 'aisha@riverstoneplumbing.ca',
    website: 'https://riverstoneplumbing.ca',
    industry: 'Plumbing',
    city: 'Toronto',
    reviews: 118,
    rating: 4.6,
    websiteQuality: 'adequate',
    ads: true,
    booking: false,
    crm: null,
    size: '6-10',
    hook: 'Your Toronto reviews suggest steady residential work',
    summary: 'Residential plumbing company running ads with no visible booking or follow-up system.',
    painPoints: ['Emergency calls prioritised over quote follow-up'],
    angle: 'speed_to_lead',
    signals: ['hiring apprentice'],
  },
  {
    company: 'Evergreen Landscape Co.',
    owner: 'Tom Brennan',
    phone: '+19055550133',
    email: 'tom@evergreenlandscape.ca',
    website: 'https://evergreenlandscape.ca',
    industry: 'Landscaping',
    city: 'Milton',
    reviews: 41,
    rating: 4.3,
    websiteQuality: 'adequate',
    ads: false,
    booking: false,
    crm: null,
    size: '3-5',
    hook: "You've been shaping Milton yards for a few seasons now",
    summary: 'Seasonal landscaping business with modest review volume and no digital follow-up process.',
    painPoints: ['Spring quote backlog never gets revisited'],
    angle: 'old_estimates',
    signals: [],
  },
];

type DemoTurn = { from: 'us' | 'them' | 'human'; body: string };

const DEMO_CONVERSATIONS: Array<{
  state: 'DISCOVERY' | 'QUALIFICATION' | 'BOOKED' | 'HUMAN_HANDOFF' | 'NOT_INTERESTED';
  intent: 'positive' | 'negative' | 'neutral' | 'question';
  temperature: 'cold' | 'warm' | 'hot';
  requiresHuman: boolean;
  handoffReason?: string;
  unread: number;
  contactStatus: 'CONTACTED' | 'REPLIED' | 'QUALIFIED' | 'APPOINTMENT' | 'LOST';
  qualification: Record<string, string | number>;
  turns: DemoTurn[];
  appointmentInHours?: number;
  dealStage: 'QUALIFIED' | 'APPOINTMENT' | 'PROPOSAL' | 'WON';
  dealValueCents: number;
  dealTitle: string;
}> = [
  {
    state: 'QUALIFICATION',
    intent: 'positive',
    temperature: 'hot',
    requiresHuman: false,
    unread: 2,
    contactStatus: 'APPOINTMENT',
    qualification: {
      monthly_lead_volume: 45,
      average_job_value: 9500,
      current_follow_up_process: 'Owner calls back when he gets a chance, usually for a week or two',
      follow_up_duration: '7-14 days',
      biggest_sales_bottleneck: 'Estimates going quiet after the first week',
    },
    turns: [
      { from: 'us', body: "Mike — quick one about Summit Ridge Roofing. You've clearly built a reputation with Mississauga homeowners. Do the leads that never booked just sit there, or does someone chase them?" },
      { from: 'them', body: 'Mostly sit there honestly. I call a few back when I get a chance' },
      { from: 'us', body: 'Got it. How long do you usually keep at one before you let it go?' },
      { from: 'them', body: 'Week, maybe two. Then it falls off' },
      { from: 'us', body: 'Makes sense. Roughly how many estimates a month go out without closing?' },
      { from: 'them', body: 'Out of maybe 45 leads we close a bit under half. So 20 odd sitting there' },
      { from: 'us', body: 'That is a real number. Are you free later today or tomorrow for 10 minutes?' },
      { from: 'them', body: 'Tomorrow morning works' },
    ],
    appointmentInHours: 20,
    dealStage: 'APPOINTMENT',
    dealValueCents: 50_000,
    dealTitle: 'Summit Ridge Roofing',
  },
  {
    state: 'DISCOVERY',
    intent: 'question',
    temperature: 'warm',
    requiresHuman: false,
    unread: 1,
    contactStatus: 'REPLIED',
    qualification: { current_follow_up_process: 'Office manager sends one follow-up email' },
    turns: [
      { from: 'us', body: 'Hi Sandra, question about Northgate Exteriors — what happens to the estimates that go out and never close?' },
      { from: 'them', body: 'Our office manager sends one follow up email. After that nothing really' },
      { from: 'us', body: 'How many of those are sitting from this year?' },
      { from: 'them', body: 'No idea off the top of my head. What is this about exactly?' },
    ],
    dealStage: 'QUALIFIED',
    dealValueCents: 50_000,
    dealTitle: 'Northgate Exteriors',
  },
  {
    state: 'HUMAN_HANDOFF',
    intent: 'question',
    temperature: 'hot',
    requiresHuman: true,
    handoffReason: 'Pricing negotiation',
    unread: 1,
    contactStatus: 'QUALIFIED',
    qualification: { monthly_lead_volume: 120, average_job_value: 14_000, team_size: 22 },
    turns: [
      { from: 'us', body: 'Dev, when a new lead comes into Trueline Roofing & Siding, roughly how fast does someone get back to them?' },
      { from: 'them', body: 'Depends. Same day usually, sometimes next morning' },
      { from: 'us', body: 'With 22 on the team that is decent. Where does it slip?' },
      { from: 'them', body: 'Weekends mostly. What does something like this run and can you do better if we sign for a year?' },
    ],
    dealStage: 'PROPOSAL',
    dealValueCents: 50_000,
    dealTitle: 'Trueline Roofing',
  },
  {
    state: 'NOT_INTERESTED',
    intent: 'negative',
    temperature: 'cold',
    requiresHuman: false,
    unread: 0,
    contactStatus: 'LOST',
    qualification: {},
    turns: [
      { from: 'us', body: 'Hi Rob — how long does Halton Comfort Heating & Air keep following up on a heating and cooling installs quote before letting it go?' },
      { from: 'them', body: 'Not interested, we are fine thanks' },
      { from: 'us', body: 'No problem at all — thanks for the reply.' },
    ],
    dealStage: 'QUALIFIED',
    dealValueCents: 0,
    dealTitle: 'Halton Comfort',
  },
  {
    state: 'BOOKED',
    intent: 'positive',
    temperature: 'hot',
    requiresHuman: false,
    unread: 0,
    contactStatus: 'APPOINTMENT',
    qualification: {
      monthly_lead_volume: 80,
      average_job_value: 2400,
      current_crm: 'None',
      biggest_sales_bottleneck: 'Quote follow-up loses to emergency calls',
    },
    turns: [
      { from: 'us', body: 'Aisha, when a new lead comes into Riverstone Plumbing, roughly how fast does someone get back to them?' },
      { from: 'them', body: 'Fast for emergencies. Quotes are slower, they get buried' },
      { from: 'us', body: 'How many quotes a month roughly?' },
      { from: 'them', body: 'Maybe 80 leads, a good chunk are quote requests' },
      { from: 'human', body: 'Aisha — Sam here, I run On Radar. Booked you in for Thursday 10am, talk then.' },
      { from: 'them', body: 'Perfect, talk Thursday' },
    ],
    appointmentInHours: -72,
    dealStage: 'WON',
    dealValueCents: 50_000,
    dealTitle: 'Riverstone Plumbing',
  },
];

/** Convenience for tests that need a bare organization with defaults applied. */
export async function seedMinimalOrg(name = 'Test Org'): Promise<{ ctx: Ctx; campaignId: string }> {
  const db = getDb();
  const [organization] = await db
    .insert(organizations)
    .values({ name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now().toString(36)}` })
    .returning();

  const ctx = systemCtx(organization!.id, organization!.timezone);
  const { campaignId } = await seedOrganizationDefaults(ctx);
  return { ctx, campaignId };
}
