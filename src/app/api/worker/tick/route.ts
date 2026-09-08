import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { errorMessage } from '@/lib/core/errors';
import { logger } from '@/lib/core/logger';
import { tick } from '@/lib/worker/tick';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Drives one worker pass over HTTP.
 *
 * The long-lived `npm run worker` process is the normal deployment; this route
 * exists so a serverless host can drive the same code from a scheduler (Vercel
 * Cron, GitHub Actions, an uptime pinger) with no separate service.
 */
export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await tick();
    return NextResponse.json(result);
  } catch (error) {
    logger.error('worker tick route failed', { errorCode: errorMessage(error).slice(0, 200) });
    return NextResponse.json({ error: 'Tick failed' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}

function authorized(request: NextRequest): boolean {
  const expected = env().WORKER_TOKEN;
  // Without a configured token the endpoint is refused rather than left open.
  if (!expected) return false;

  const header = request.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : (request.nextUrl.searchParams.get('token') ?? '');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
