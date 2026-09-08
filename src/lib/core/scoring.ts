import { z } from 'zod';

/**
 * On Radar lead score.
 *
 * Every rule is data, not code: an org can reweight, disable, or add rules from
 * Settings without a deploy. Every score records the exact rules that fired so
 * the UI can answer "why is this an A?" — no black-box numbers.
 */
export const scoringRuleSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  points: z.number().int().min(-100).max(100),
  enabled: z.boolean().default(true),
  /** Explains to the operator what the rule is actually testing. */
  description: z.string().default(''),
});

export const scoringConfigSchema = z.object({
  version: z.string().default('v1'),
  maxScore: z.number().int().positive().default(100),
  rules: z.array(scoringRuleSchema),
  buckets: z
    .array(z.object({ label: z.string(), min: z.number().int() }))
    .default([
      { label: 'A', min: 80 },
      { label: 'B', min: 60 },
      { label: 'C', min: 40 },
      { label: 'D', min: 0 },
    ]),
});

export type ScoringRule = z.infer<typeof scoringRuleSchema>;
export type ScoringConfig = z.infer<typeof scoringConfigSchema>;

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  version: 'v1',
  maxScore: 100,
  buckets: [
    { label: 'A', min: 80 },
    { label: 'B', min: 60 },
    { label: 'C', min: 40 },
    { label: 'D', min: 0 },
  ],
  rules: [
    {
      key: 'high_ticket_service',
      label: 'High-ticket service',
      points: 20,
      enabled: true,
      description: 'Industry is on the high average-job-value list.',
    },
    {
      key: 'reviews_50_plus',
      label: '50+ Google reviews',
      points: 10,
      enabled: true,
      description: 'Established demand and real customer flow.',
    },
    {
      key: 'active_advertising',
      label: 'Active advertising',
      points: 20,
      enabled: true,
      description: 'Paying for leads today, so lost leads cost them money.',
    },
    {
      key: 'weak_follow_up',
      label: 'Weak follow-up infrastructure',
      points: 20,
      enabled: true,
      description: 'No CRM and no booking system detected.',
    },
    {
      key: 'owner_identifiable',
      label: 'Owner identifiable',
      points: 10,
      enabled: true,
      description: 'A named decision-maker to address.',
    },
    {
      key: 'good_website',
      label: 'Good website',
      points: 5,
      enabled: true,
      description: 'Site quality suggests they invest in the business.',
    },
    {
      key: 'multiple_crews',
      label: 'Multiple crews',
      points: 10,
      enabled: true,
      description: 'Estimated company size above a solo operator.',
    },
    {
      key: 'recent_growth_signal',
      label: 'Recent growth signal',
      points: 5,
      enabled: true,
      description: 'Hiring, expansion, or new-location signals in research.',
    },
  ],
};

/** Industries that clear the high-ticket bar by default. Editable per org. */
export const DEFAULT_HIGH_TICKET_INDUSTRIES = [
  'roofing',
  'hvac',
  'plumbing',
  'renovation',
  'home renovation',
  'remodeling',
  'landscaping',
  'solar',
  'windows',
  'foundation',
  'restoration',
  'paving',
];

export type ScoringInput = {
  industry?: string | null;
  googleReviews?: number | null;
  googleRating?: number | null;
  adPresence?: boolean | null;
  crmDetected?: string | null;
  bookingSystemDetected?: boolean | null;
  ownerName?: string | null;
  websiteQuality?: string | null;
  website?: string | null;
  estimatedCompanySize?: string | null;
  leadGenerationSignals?: string[] | null;
  highTicketIndustries?: string[];
};

export type ScoreLine = {
  key: string;
  label: string;
  points: number;
  awarded: boolean;
  /** Why the rule did or did not fire, in operator-readable language. */
  reason: string;
};

export type ScoreResult = {
  score: number;
  bucket: string;
  version: string;
  breakdown: ScoreLine[];
  maxScore: number;
};

type Evaluation = { awarded: boolean; reason: string };

const UNKNOWN: Evaluation = { awarded: false, reason: 'Unknown — not enough research data' };

function evaluate(key: string, input: ScoringInput): Evaluation {
  switch (key) {
    case 'high_ticket_service': {
      if (!input.industry) return UNKNOWN;
      const list = input.highTicketIndustries ?? DEFAULT_HIGH_TICKET_INDUSTRIES;
      const industry = input.industry.toLowerCase();
      const hit = list.some((i) => industry.includes(i.toLowerCase()));
      return {
        awarded: hit,
        reason: hit ? `${input.industry} is a high-ticket service` : `${input.industry} is not on the high-ticket list`,
      };
    }
    case 'reviews_50_plus': {
      if (input.googleReviews === null || input.googleReviews === undefined) return UNKNOWN;
      const hit = input.googleReviews >= 50;
      return { awarded: hit, reason: `${input.googleReviews} Google reviews` };
    }
    case 'active_advertising': {
      if (input.adPresence === null || input.adPresence === undefined) return UNKNOWN;
      return {
        awarded: input.adPresence,
        reason: input.adPresence ? 'Active paid advertising detected' : 'No advertising detected',
      };
    }
    case 'weak_follow_up': {
      const crmKnown = input.crmDetected !== undefined;
      const bookingKnown = input.bookingSystemDetected !== null && input.bookingSystemDetected !== undefined;
      if (!crmKnown && !bookingKnown) return UNKNOWN;
      const hasCrm = Boolean(input.crmDetected);
      const hasBooking = Boolean(input.bookingSystemDetected);
      const hit = !hasCrm && !hasBooking;
      if (hit) return { awarded: true, reason: 'No CRM or booking system detected' };
      const found = [hasCrm ? `CRM (${input.crmDetected})` : null, hasBooking ? 'booking system' : null]
        .filter(Boolean)
        .join(' and ');
      return { awarded: false, reason: `Already running ${found}` };
    }
    case 'owner_identifiable': {
      const hit = Boolean(input.ownerName && input.ownerName.trim());
      return { awarded: hit, reason: hit ? `Owner identified: ${input.ownerName}` : 'No named owner found' };
    }
    case 'good_website': {
      if (!input.websiteQuality) {
        if (!input.website) return { awarded: false, reason: 'No website found' };
        return UNKNOWN;
      }
      const hit = ['strong', 'adequate'].includes(input.websiteQuality.toLowerCase());
      return { awarded: hit, reason: `Website quality rated ${input.websiteQuality}` };
    }
    case 'multiple_crews': {
      if (!input.estimatedCompanySize) return UNKNOWN;
      const size = input.estimatedCompanySize.toLowerCase();
      const solo = /^(1|solo|owner[- ]?operator|1-2|2)$/.test(size.trim());
      return {
        awarded: !solo,
        reason: solo ? 'Appears to be an owner-operator' : `Estimated size: ${input.estimatedCompanySize}`,
      };
    }
    case 'recent_growth_signal': {
      const signals = input.leadGenerationSignals ?? [];
      const growth = signals.filter((s) => /hiring|expand|new location|growth|now serving/i.test(s));
      return {
        awarded: growth.length > 0,
        reason: growth.length > 0 ? `Growth signals: ${growth.join(', ')}` : 'No growth signals found',
      };
    }
    default:
      return { awarded: false, reason: 'No evaluator for this rule' };
  }
}

export function scoreProspect(
  input: ScoringInput,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): ScoreResult {
  const breakdown: ScoreLine[] = [];
  let total = 0;

  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    const { awarded, reason } = evaluate(rule.key, input);
    if (awarded) total += rule.points;
    breakdown.push({ key: rule.key, label: rule.label, points: rule.points, awarded, reason });
  }

  const score = Math.max(0, Math.min(config.maxScore, total));
  return { score, bucket: bucketFor(score, config), version: config.version, breakdown, maxScore: config.maxScore };
}

export function bucketFor(score: number, config: ScoringConfig = DEFAULT_SCORING_CONFIG): string {
  const sorted = [...config.buckets].sort((a, b) => b.min - a.min);
  for (const bucket of sorted) if (score >= bucket.min) return bucket.label;
  return sorted[sorted.length - 1]?.label ?? 'D';
}

export function parseScoringConfig(raw: unknown): ScoringConfig {
  const parsed = scoringConfigSchema.safeParse(raw);
  if (!parsed.success || parsed.data.rules.length === 0) return DEFAULT_SCORING_CONFIG;
  return parsed.data;
}
