import { describe, it, expect } from 'vitest';
import { normalizePhone, formatPhone, normalizeEmail, normalizeName, companyKey } from '@/lib/core/phone';
import { render, renderStrict, extractVariables, segmentInfo } from '@/lib/core/template';
import { scoreProspect, DEFAULT_SCORING_CONFIG, bucketFor } from '@/lib/core/scoring';
import { classifyInbound, isOptOut, detectHandoffSignal } from '@/lib/core/intent';
import { withinSendingWindow, nextWindowOpening, parseClock } from '@/lib/core/time';
import { parseCsv, toCsv, autoMapColumns, splitName } from '@/lib/core/csv';
import { extractJson } from '@/lib/agents/schemas';
import { backoffMs } from '@/lib/services/queue';

describe('phone normalization', () => {
  it('normalizes NANP numbers in every common written form', () => {
    for (const input of ['4165551234', '(416) 555-1234', '416-555-1234', '1 416 555 1234', '+14165551234']) {
      expect(normalizePhone(input).e164, input).toBe('+14165551234');
    }
  });

  it('rejects numbers that cannot be dialled', () => {
    expect(normalizePhone('123').valid).toBe(false);
    expect(normalizePhone('').valid).toBe(false);
    expect(normalizePhone('0000000000').valid).toBe(false);
    // NANP area codes and exchanges never start with 0 or 1.
    expect(normalizePhone('1165551234').valid).toBe(false);
    expect(normalizePhone('4160551234').valid).toBe(false);
  });

  it('keeps international numbers in E.164 without inventing a country', () => {
    expect(normalizePhone('+442071234567').e164).toBe('+442071234567');
    expect(normalizePhone('+61 2 9374 4000').e164).toBe('+61293744000');
  });

  it('formats and normalizes supporting fields', () => {
    expect(formatPhone('+14165551234')).toBe('(416) 555-1234');
    expect(formatPhone(null)).toBe('—');
    expect(normalizeEmail('  Mike@Example.COM ')).toBe('mike@example.com');
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeName("mike o'brien-smith")).toBe("Mike O'brien-Smith");
    expect(normalizeName('McDonald')).toBe('McDonald');
    expect(companyKey('ABC Roofing Inc.')).toBe(companyKey('abc roofing'));
    expect(companyKey('ABC Roofing')).not.toBe(companyKey('XYZ Roofing'));
  });
});

describe('message templating', () => {
  it('substitutes variables and reports the ones it could not fill', () => {
    const result = render('Hi {{first_name}} at {{company}} in {{city}}', {
      first_name: 'Mike',
      company: 'Summit Ridge',
    });
    expect(result.text).toBe('Hi Mike at Summit Ridge in {{city}}');
    expect(result.missing).toEqual(['city']);
  });

  it('treats blank values as missing rather than rendering an empty gap', () => {
    expect(render('Hi {{first_name}}', { first_name: '   ' }).missing).toEqual(['first_name']);
    expect(render('Hi {{first_name}}', { first_name: null }).missing).toEqual(['first_name']);
  });

  it('refuses to render strictly when data is missing', () => {
    expect(() => renderStrict('Hi {{first_name}}', {})).toThrow(/unresolved variables/i);
    expect(renderStrict('Hi {{first_name}}', { first_name: 'Mike' })).toBe('Hi Mike');
  });

  it('extracts declared variables', () => {
    expect(extractVariables('{{a}} and {{ b }} and {{a}}').sort()).toEqual(['a', 'b']);
  });

  it('counts SMS segments the way a carrier bills them', () => {
    expect(segmentInfo('a'.repeat(160))).toMatchObject({ segments: 1, encoding: 'GSM-7' });
    expect(segmentInfo('a'.repeat(161))).toMatchObject({ segments: 2, encoding: 'GSM-7' });
    // A single emoji forces UCS-2 and drops the per-segment budget to 70.
    expect(segmentInfo('hello U')).toMatchObject({ encoding: 'GSM-7' });
    expect(segmentInfo('\u{1F642}'.repeat(40)).segments).toBeGreaterThan(1);
    expect(segmentInfo('\u{1F642}').encoding).toBe('UCS-2');
  });
});

describe('On Radar lead score', () => {
  const highValue = {
    industry: 'Roofing',
    googleReviews: 187,
    adPresence: true,
    crmDetected: null,
    bookingSystemDetected: false,
    ownerName: 'Mike Delaney',
    websiteQuality: 'strong',
    estimatedCompanySize: '12-20',
    leadGenerationSignals: ['hiring crew leads'],
  };

  it('scores an ideal prospect at the top of the A bucket', () => {
    const result = scoreProspect(highValue);
    expect(result.score).toBe(100);
    expect(result.bucket).toBe('A');
  });

  it('explains every rule, including the ones that did not fire', () => {
    const result = scoreProspect({ industry: 'Roofing', googleReviews: 10 });
    const reviews = result.breakdown.find((line) => line.key === 'reviews_50_plus');
    expect(reviews?.awarded).toBe(false);
    expect(reviews?.reason).toContain('10 Google reviews');
    expect(result.breakdown).toHaveLength(DEFAULT_SCORING_CONFIG.rules.length);
  });

  it('marks unknown data as unknown instead of guessing', () => {
    const result = scoreProspect({ industry: 'Roofing' });
    const ads = result.breakdown.find((line) => line.key === 'active_advertising');
    expect(ads?.awarded).toBe(false);
    expect(ads?.reason).toMatch(/unknown/i);
  });

  it('withholds the weak-follow-up points when they already have tooling', () => {
    const result = scoreProspect({ ...highValue, crmDetected: 'JobNimbus', bookingSystemDetected: true });
    const rule = result.breakdown.find((line) => line.key === 'weak_follow_up');
    expect(rule?.awarded).toBe(false);
    expect(rule?.reason).toContain('JobNimbus');
    expect(result.score).toBe(80);
  });

  it('honours a reweighted config', () => {
    const config = {
      ...DEFAULT_SCORING_CONFIG,
      rules: DEFAULT_SCORING_CONFIG.rules.map((rule) =>
        rule.key === 'reviews_50_plus' ? { ...rule, enabled: false } : rule,
      ),
    };
    expect(scoreProspect(highValue, config).score).toBe(90);
  });

  it('maps scores to buckets at the boundaries', () => {
    expect(bucketFor(80)).toBe('A');
    expect(bucketFor(79)).toBe('B');
    expect(bucketFor(60)).toBe('B');
    expect(bucketFor(59)).toBe('C');
    expect(bucketFor(0)).toBe('D');
  });
});

describe('inbound classification', () => {
  it('detects carrier-standard opt-out keywords', () => {
    for (const text of ['STOP', 'stop', 'Unsubscribe', 'QUIT', 'remove me from this list', 'do not contact me again']) {
      expect(isOptOut(text), text).toBe(true);
    }
  });

  it('does not read an incidental keyword as an opt-out', () => {
    // The word appears, but the message is plainly not a withdrawal of consent.
    expect(isOptOut('I had to cancel my appointment yesterday')).toBe(false);
    expect(isOptOut('we stop work at 5pm')).toBe(false);
    expect(isOptOut('Yes, send me the details')).toBe(false);
  });

  it('classifies replies into actionable intents', () => {
    expect(classifyInbound('STOP').intent).toBe('opt_out');
    expect(classifyInbound('yes tell me more').intent).toBe('positive');
    expect(classifyInbound('not interested').intent).toBe('negative');
    expect(classifyInbound('you have the wrong number').intent).toBe('wrong_number');
    expect(classifyInbound('what does it cost?').intent).toBe('question');
    expect(classifyInbound('mm').intent).toBe('neutral');
  });

  it('only suppresses on an explicit wrong-number claim', () => {
    // wrong_number suppresses the contact permanently, so the bar is high.
    // "Who is this?" is far more often a curious prospect than a misdirect,
    // and is handled as a question that a human picks up.
    expect(classifyInbound('who is this?').intent).toBe('question');
    expect(detectHandoffSignal('who is this?')).toMatch(/who is contacting/i);
    expect(classifyInbound('wrong number mate').intent).toBe('wrong_number');
    expect(classifyInbound('I think you have the wrong person').intent).toBe('wrong_number');
  });

  it('flags conversations a human has to take', () => {
    expect(detectHandoffSignal('can I talk to a real person')).toMatch(/human/i);
    expect(detectHandoffSignal('are you a bot?')).toMatch(/bot/i);
    expect(detectHandoffSignal('what discount can you do')).toMatch(/pricing/i);
    expect(detectHandoffSignal('my lawyer will be in touch')).toMatch(/legal/i);
    expect(detectHandoffSignal('sounds good, what times work')).toBeNull();
  });
});

describe('sending windows', () => {
  // 2026-09-08 is a Tuesday; Toronto is UTC-4 in September.
  const tuesday2pmToronto = new Date('2026-09-08T18:00:00Z');
  const tuesday3amToronto = new Date('2026-09-08T07:00:00Z');
  const saturdayNoon = new Date('2026-09-12T16:00:00Z');

  it('respects local time and allowed weekdays', () => {
    expect(withinSendingWindow(tuesday2pmToronto, 'America/Toronto', '09:00', '19:00', [1, 2, 3, 4, 5])).toBe(true);
    expect(withinSendingWindow(tuesday3amToronto, 'America/Toronto', '09:00', '19:00', [1, 2, 3, 4, 5])).toBe(false);
    expect(withinSendingWindow(saturdayNoon, 'America/Toronto', '09:00', '19:00', [1, 2, 3, 4, 5])).toBe(false);
  });

  it('handles a window that wraps past midnight', () => {
    expect(withinSendingWindow(tuesday3amToronto, 'America/Toronto', '21:00', '09:00', [0, 1, 2, 3, 4, 5, 6])).toBe(true);
    expect(withinSendingWindow(tuesday2pmToronto, 'America/Toronto', '21:00', '09:00', [0, 1, 2, 3, 4, 5, 6])).toBe(false);
  });

  it('finds the next opening rather than dropping the message', () => {
    const next = nextWindowOpening(tuesday3amToronto, 'America/Toronto', '09:00', '19:00', [1, 2, 3, 4, 5]);
    expect(next.getTime()).toBeGreaterThan(tuesday3amToronto.getTime());
    expect(withinSendingWindow(next, 'America/Toronto', '09:00', '19:00', [1, 2, 3, 4, 5])).toBe(true);
  });

  it('parses clock strings defensively', () => {
    expect(parseClock('09:30')).toEqual({ hour: 9, minute: 30 });
    expect(parseClock('nonsense')).toEqual({ hour: 9, minute: 0 });
  });
});

describe('CSV handling', () => {
  it('parses quoted fields, embedded commas, newlines and escaped quotes', () => {
    const rows = parseCsv('name,note\n"Smith, Bob","He said ""hi""\nthen left"\n');
    expect(rows[1]).toEqual(['Smith, Bob', 'He said "hi"\nthen left']);
  });

  it('strips a UTF-8 BOM so the first header is not corrupted', () => {
    expect(parseCsv('﻿phone\n4165551234')[0]).toEqual(['phone']);
  });

  it('round-trips through serialization', () => {
    const rows = [{ a: 'x,y', b: 'say "hi"' }];
    expect(parseCsv(toCsv(rows))[1]).toEqual(['x,y', 'say "hi"']);
  });

  it('auto-maps realistic scraped headers', () => {
    const mapping = autoMapColumns(['Business Name', 'Phone Number', 'City', 'Google Reviews', 'Website']);
    expect(mapping.companyName).toBe(0);
    expect(mapping.phone).toBe(1);
    expect(mapping.city).toBe(2);
    expect(mapping.googleReviews).toBe(3);
    expect(mapping.website).toBe(4);
  });

  it('splits full names', () => {
    expect(splitName('Mike Delaney')).toEqual({ firstName: 'Mike', lastName: 'Delaney' });
    expect(splitName('Aisha')).toEqual({ firstName: 'Aisha', lastName: null });
    expect(splitName('Ana Maria De Souza').lastName).toBe('Maria De Souza');
  });
});

describe('AI structured output parsing', () => {
  it('parses bare JSON, fenced JSON and JSON wrapped in prose', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":1} hope that helps')).toEqual({ a: 1 });
  });

  it('returns null rather than guessing when there is no object', () => {
    expect(extractJson('no json here')).toBeNull();
    expect(extractJson('{ broken')).toBeNull();
  });
});

describe('queue backoff', () => {
  it('grows exponentially and caps', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(20)).toBe(30 * 60_000);
  });
});
