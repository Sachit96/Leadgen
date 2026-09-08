import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEYLEN = 64;

/**
 * scrypt via node:crypto — no native build step, and strong enough for an
 * internal sales tool. Format: `scrypt:<salt-hex>:<hash-hex>`.
 */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  if (expected.length !== KEYLEN) return false;
  const actual = await scrypt(password, salt, KEYLEN);
  return timingSafeEqual(actual, expected);
}
