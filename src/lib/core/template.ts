import { AppError } from './errors';

/**
 * Message templating with {{variable}} substitution.
 *
 * Rule: an outbound message is never sent with an unresolved variable. Render
 * returns the list of missing keys and callers must treat a non-empty list as a
 * hard failure (`renderStrict` does it for them).
 */
export type TemplateVars = Record<string, string | number | null | undefined>;

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export type RenderResult = {
  text: string;
  missing: string[];
  used: string[];
};

export function extractVariables(template: string): string[] {
  const out = new Set<string>();
  for (const match of template.matchAll(TOKEN)) out.add(match[1]!);
  return [...out];
}

export function render(template: string, vars: TemplateVars): RenderResult {
  const missing: string[] = [];
  const used: string[] = [];

  const text = template.replace(TOKEN, (_full, rawKey: string) => {
    const key = rawKey.trim();
    const value = vars[key];
    if (value === null || value === undefined || String(value).trim() === '') {
      if (!missing.includes(key)) missing.push(key);
      return `{{${key}}}`;
    }
    used.push(key);
    return String(value).trim();
  });

  return { text: collapseWhitespace(text), missing, used };
}

export function renderStrict(template: string, vars: TemplateVars): string {
  const result = render(template, vars);
  if (result.missing.length > 0) {
    throw new AppError(
      'VALIDATION',
      `Message has unresolved variables: ${result.missing.map((v) => `{{${v}}}`).join(', ')}`,
      { missing: result.missing },
    );
  }
  return result.text;
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const GSM7 =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = '^{}\\[~]|€';

/** SMS segment accounting, so the composer's counter matches carrier billing. */
export function segmentInfo(text: string): {
  characters: number;
  segments: number;
  encoding: 'GSM-7' | 'UCS-2';
  perSegment: number;
} {
  let gsmLength = 0;
  let isGsm = true;
  for (const char of text) {
    if (GSM7.includes(char)) gsmLength += 1;
    else if (GSM7_EXT.includes(char)) gsmLength += 2;
    else {
      isGsm = false;
      break;
    }
  }

  if (isGsm) {
    const perSegment = gsmLength <= 160 ? 160 : 153;
    return {
      characters: gsmLength,
      segments: gsmLength === 0 ? 0 : Math.ceil(gsmLength / perSegment),
      encoding: 'GSM-7',
      perSegment,
    };
  }

  const units = [...text].reduce((n, c) => n + (c.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  const perSegment = units <= 70 ? 70 : 67;
  return {
    characters: units,
    segments: units === 0 ? 0 : Math.ceil(units / perSegment),
    encoding: 'UCS-2',
    perSegment,
  };
}
