import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { integrationStatus } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const checks: Record<string, string> = {};
  let healthy = true;

  try {
    await getDb().execute(sql`select 1`);
    checks.database = 'ok';
  } catch (error) {
    healthy = false;
    checks.database = error instanceof Error ? error.message.slice(0, 120) : 'error';
  }

  try {
    const status = integrationStatus();
    checks.sms = status.sms.effective;
    checks.ai = status.ai.effective;
    checks.calendar = status.calendar.effective;
  } catch (error) {
    healthy = false;
    checks.env = error instanceof Error ? error.message.slice(0, 200) : 'invalid';
  }

  return NextResponse.json({ ok: healthy, checks }, { status: healthy ? 200 : 503 });
}
