import { NextResponse, type NextRequest } from 'next/server';
import { requireCtx } from '@/lib/auth/context';
import { isAppError } from '@/lib/core/errors';
import { listInbox, type InboxFilter } from '@/lib/services/conversations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FILTERS: InboxFilter[] = [
  'all',
  'unread',
  'needs_human',
  'hot',
  'ai_active',
  'booked',
  'closed',
  'mine',
];

/**
 * Backs the inbox sidebar.
 *
 * The list lives in a layout, which App Router does not give search params to,
 * so it fetches its own filtered page here — keeping filtering in SQL while the
 * list stays mounted across conversation selections.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await requireCtx('conversation:read');
    const params = request.nextUrl.searchParams;

    const requested = params.get('filter') ?? 'all';
    const filter = (FILTERS.includes(requested as InboxFilter) ? requested : 'all') as InboxFilter;

    const { rows, total } = await listInbox(ctx, {
      filter,
      search: params.get('q') ?? undefined,
      limit: Math.min(100, Number(params.get('limit') ?? 60) || 60),
    });

    return NextResponse.json({ rows, total }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (isAppError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: 'Could not load conversations' }, { status: 500 });
  }
}
