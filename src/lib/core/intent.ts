/**
 * Deterministic first-pass classification of inbound SMS.
 *
 * This runs before any model call. Opt-out detection in particular must never
 * depend on an AI provider being reachable: a STOP that fails to register is a
 * compliance problem, so it is decided here with plain string matching.
 */
export type Intent = 'positive' | 'negative' | 'neutral' | 'question' | 'opt_out' | 'wrong_number' | 'unknown';

/** Carrier-standard opt-out keywords plus common natural-language variants. */
const OPT_OUT_KEYWORDS = [
  'stop',
  'stopall',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  'optout',
  'opt out',
  'remove me',
  'take me off',
  'do not contact',
  'don’t contact me',
  'dont contact me',
  'do not text',
  'dont text me',
  'don’t text me',
  'stop texting',
  'stop messaging',
  'leave me alone',
];

const WRONG_NUMBER = [
  'wrong number',
  'wrong person',
  'who is this',
  "who's this",
  'you have the wrong',
  'not me',
  'i think you have the wrong',
];

const POSITIVE = [
  'yes',
  'yeah',
  'yep',
  'yup',
  'sure',
  'interested',
  'tell me more',
  'sounds good',
  'how does it work',
  'ok',
  'okay',
  'lets do it',
  "let's do it",
  'send it',
  'go ahead',
  'im in',
  "i'm in",
  'what times',
  'available',
  'book',
  'call me',
];

const NEGATIVE = [
  'not interested',
  'no thanks',
  'no thank you',
  'we’re good',
  'were good',
  'we are good',
  'all set',
  'pass',
  'not right now',
  'not at this time',
  'no need',
  'already have',
  'nope',
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function isOptOut(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;
  // A bare keyword ("STOP") is the carrier convention.
  if (OPT_OUT_KEYWORDS.includes(normalized)) return true;
  // Phrases are matched anywhere; single words only as the whole message, so
  // "I had to cancel my appointment" is not read as an opt-out.
  return OPT_OUT_KEYWORDS.filter((k) => k.includes(' ')).some((k) => normalized.includes(k));
}

export type ClassificationResult = {
  intent: Intent;
  confidence: number;
  matched: string | null;
};

export function classifyInbound(text: string): ClassificationResult {
  const normalized = normalize(text);
  if (!normalized) return { intent: 'unknown', confidence: 0, matched: null };

  if (isOptOut(text)) return { intent: 'opt_out', confidence: 1, matched: 'opt_out_keyword' };

  const wrong = WRONG_NUMBER.find((k) => normalized.includes(k));
  if (wrong) return { intent: 'wrong_number', confidence: 0.9, matched: wrong };

  const negative = NEGATIVE.find((k) => normalized.includes(k));
  if (negative) return { intent: 'negative', confidence: 0.85, matched: negative };

  const positive = POSITIVE.find((k) => normalized === k || normalized.startsWith(`${k} `));
  if (positive) return { intent: 'positive', confidence: 0.8, matched: positive };

  const positiveAnywhere = POSITIVE.filter((k) => k.includes(' ')).find((k) => normalized.includes(k));
  if (positiveAnywhere) return { intent: 'positive', confidence: 0.7, matched: positiveAnywhere };

  if (text.includes('?')) return { intent: 'question', confidence: 0.6, matched: 'question_mark' };

  return { intent: 'neutral', confidence: 0.4, matched: null };
}

/** Signals that a human should take the conversation. Checked before AI reply. */
const HANDOFF_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(speak|talk|chat)\s+(to|with)\s+(a\s+)?(human|person|someone|real)/i, reason: 'Asked to speak with a human' },
  { pattern: /\bare you (a )?(bot|robot|ai|human|real)\b/i, reason: 'Asked whether they are talking to a bot' },
  { pattern: /\b(lawyer|attorney|legal|lawsuit|sue|tcpa|cease and desist)\b/i, reason: 'Legal language used' },
  { pattern: /\b(contract|terms|invoice|refund|billing)\b/i, reason: 'Contract or billing question' },
  { pattern: /\b(discount|negotiate|lower price|best price|price match)\b/i, reason: 'Pricing negotiation' },
  { pattern: /\b(scam|spam|fraud|harass|report you|complain)\b/i, reason: 'Complaint or accusation' },
  { pattern: /\b(sign up now|ready to start|take my (money|card)|send.*invoice|how do i pay)\b/i, reason: 'Ready to buy immediately' },
];

export function detectHandoffSignal(text: string): string | null {
  for (const { pattern, reason } of HANDOFF_PATTERNS) if (pattern.test(text)) return reason;
  return null;
}
