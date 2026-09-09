/**
 * RFC 4180 CSV parsing and serialization.
 *
 * Written by hand rather than pulled in as a dependency because the import path
 * needs exact control over quoted fields, embedded newlines and BOM handling —
 * "close enough" parsing is how imports silently corrupt a prospect list.
 */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (char === '\r') {
      i += 1;
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) return columns ? `${columns.join(',')}\n` : '';
  const keys = columns ?? Object.keys(rows[0]!);
  const lines = [keys.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(keys.map((key) => escapeCell(row[key])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Column aliases the importer recognizes, so a raw scrape maps without work. */
export const COLUMN_ALIASES: Record<string, string[]> = {
  firstName: ['first name', 'firstname', 'first', 'given name', 'contact first name'],
  lastName: ['last name', 'lastname', 'last', 'surname', 'family name'],
  fullName: ['name', 'full name', 'contact', 'contact name', 'owner', 'owner name'],
  phone: ['phone', 'phone number', 'mobile', 'cell', 'telephone', 'tel', 'primary phone'],
  email: ['email', 'email address', 'e-mail'],
  companyName: ['company', 'company name', 'business', 'business name', 'organization'],
  website: ['website', 'url', 'web', 'site', 'domain'],
  city: ['city', 'town', 'locality'],
  province: ['province', 'state', 'region'],
  industry: ['industry', 'category', 'type', 'business type', 'niche'],
  googleReviews: ['reviews', 'review count', 'google reviews', 'number of reviews'],
  googleRating: ['rating', 'google rating', 'stars', 'average rating'],
  title: ['title', 'job title', 'role', 'position'],
};

/** Best-guess header mapping; the UI shows it for confirmation before import. */
export function autoMapColumns(headers: string[]): Record<string, number> {
  const mapping: Record<string, number> = {};
  const normalized = headers.map((h) => h.trim().toLowerCase());

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const index = normalized.findIndex((header) => aliases.includes(header));
    if (index !== -1) mapping[field] = index;
  }

  // Fall back to substring matching for headers like "Business Phone Number".
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (mapping[field] !== undefined) continue;
    const index = normalized.findIndex((header) =>
      aliases.some((alias) => header.includes(alias)),
    );
    if (index !== -1) mapping[field] = index;
  }

  return mapping;
}

export function splitName(full: string): { firstName: string | null; lastName: string | null } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: null };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}
