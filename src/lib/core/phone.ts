/**
 * Phone normalization for North American numbers (NANP), with a permissive
 * fallback for other E.164 input.
 *
 * Dedupe across the CRM keys on `normalizePhone().e164`, so this has to be
 * deterministic and conservative: when a number cannot be normalized with
 * confidence we return `valid: false` rather than guessing.
 */
export type NormalizedPhone = {
  valid: boolean;
  e164: string | null;
  national: string | null;
  countryCode: string | null;
  reason?: string;
};

const NANP_AREA_CODE_START = /^[2-9]/;

export function normalizePhone(input: string | null | undefined, defaultCountry = 'US'): NormalizedPhone {
  if (!input) return { valid: false, e164: null, national: null, countryCode: null, reason: 'empty' };

  const trimmed = String(input).trim();
  const hadPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^\d]/g, '');

  if (digits.length === 0) {
    return { valid: false, e164: null, national: null, countryCode: null, reason: 'no_digits' };
  }

  // Reject obvious placeholders such as 0000000000 or 1111111111.
  if (/^(\d)\1+$/.test(digits)) {
    return { valid: false, e164: null, national: null, countryCode: null, reason: 'repeated_digits' };
  }

  const isNanpDefault = defaultCountry === 'US' || defaultCountry === 'CA';

  if (isNanpDefault && !hadPlus) {
    if (digits.length === 10) return nanp(digits);
    if (digits.length === 11 && digits.startsWith('1')) return nanp(digits.slice(1));
  }

  if (hadPlus || digits.length > 11) {
    if (digits.length === 11 && digits.startsWith('1')) return nanp(digits.slice(1));
    if (digits.length >= 8 && digits.length <= 15) {
      return {
        valid: true,
        e164: `+${digits}`,
        national: digits,
        countryCode: null,
      };
    }
  }

  return {
    valid: false,
    e164: null,
    national: null,
    countryCode: null,
    reason: digits.length < 10 ? 'too_short' : 'unrecognized_format',
  };
}

function nanp(ten: string): NormalizedPhone {
  const area = ten.slice(0, 3);
  const exchange = ten.slice(3, 6);
  if (!NANP_AREA_CODE_START.test(area) || !NANP_AREA_CODE_START.test(exchange)) {
    return { valid: false, e164: null, national: null, countryCode: null, reason: 'invalid_nanp_prefix' };
  }
  return { valid: true, e164: `+1${ten}`, national: ten, countryCode: '1' };
}

/** Human-facing rendering: +14165551234 -> (416) 555-1234. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '—';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (!m) return e164;
  return `(${m[1]}) ${m[2]}-${m[3]}`;
}

export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = String(input).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

/** Title-cases a name without mangling initialisms or hyphenated surnames. */
export function normalizeName(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = String(input).trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  if (trimmed !== trimmed.toLowerCase() && trimmed !== trimmed.toUpperCase()) return trimmed;
  return trimmed
    .split(' ')
    .map((word) =>
      word
        .split('-')
        .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1).toLowerCase() : part))
        .join('-'),
    )
    .join(' ');
}

const COMPANY_SUFFIXES = /\b(inc|inc\.|llc|ltd|ltd\.|corp|corp\.|co|co\.|limited|incorporated)\b/gi;

/** Comparison key for duplicate company detection. Not for display. */
export function companyKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = String(name)
    .toLowerCase()
    .replace(COMPANY_SUFFIXES, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
  return key || null;
}
