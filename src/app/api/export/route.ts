import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireCtx } from '@/lib/auth/context';
import { isAppError } from '@/lib/core/errors';
import { exportCsv, type ExportKind } from '@/lib/services/export';
import { recordAudit } from '@/lib/services/activity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  kind: z.enum([
    'prospects',
    'conversations',
    'campaign_analytics',
    'variant_analytics',
    'pipeline',
    'appointments',
    'activities',
  ]),
  range: z.string().optional(),
  search: z.string().optional(),
  status: z.string().optional(),
  bucket: z.string().optional(),
  campaignId: z.string().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const ctx = await requireCtx('analytics:read');
    const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Unknown export type' }, { status: 422 });
    }

    const { kind, range, search, status, bucket, campaignId } = parsed.data;
    const file = await exportCsv(ctx, kind as ExportKind, {
      range,
      filters: {
        search,
        status: status ? (status.split(',') as never) : undefined,
        bucket: bucket ? bucket.split(',') : undefined,
        campaignId,
      },
    });

    await recordAudit(ctx, {
      action: 'export',
      entityType: kind,
      metadata: { bytes: file.content.length },
    });

    return new NextResponse(file.content, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (isAppError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: 'Export failed' }, { status: 500 });
  }
}
