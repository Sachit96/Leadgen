import { revalidatePath } from 'next/cache';
import { actionFail, actionOk, type ActionResult } from '@/lib/core/errors';
import { logger } from '@/lib/core/logger';

/**
 * Wraps a server action so it always resolves to a discriminated result rather
 * than throwing across the RSC boundary. The UI renders `error` directly, so
 * messages must be safe to show a user — which is what AppError guarantees.
 */
export async function action<T>(
  name: string,
  fn: () => Promise<T>,
  revalidate: string[] = [],
): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    for (const path of revalidate) revalidatePath(path);
    return actionOk(data);
  } catch (error) {
    const result = actionFail(error);
    if (result.code === 'INTERNAL') {
      logger.error(`action ${name} failed`, { errorCode: result.error.slice(0, 200) });
    }
    return result;
  }
}

export function str(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

export function optionalStr(form: FormData, key: string): string | null {
  const value = str(form, key);
  return value === '' ? null : value;
}

export function num(form: FormData, key: string, fallback: number): number {
  const parsed = Number(str(form, key));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function optionalNum(form: FormData, key: string): number | null {
  const raw = str(form, key);
  if (raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function bool(form: FormData, key: string): boolean {
  const value = form.get(key);
  return value === 'on' || value === 'true' || value === '1';
}

export function list(form: FormData, key: string): string[] {
  return form.getAll(key).filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

/** Parses "$1,250.50" or "1250" into cents without floating-point drift. */
export function moneyToCents(input: string): number {
  const cleaned = input.replace(/[^\d.-]/g, '');
  if (!cleaned) return 0;
  const [whole = '0', fraction = ''] = cleaned.split('.');
  const cents = Number(`${whole}${fraction.padEnd(2, '0').slice(0, 2)}`);
  return Number.isFinite(cents) ? cents : 0;
}
