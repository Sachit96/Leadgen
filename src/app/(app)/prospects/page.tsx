import Link from 'next/link';
import { requireCtx } from '@/lib/auth/context';
import {
  countByStatus,
  listCities,
  listProspects,
  type ProspectFilters,
  type ProspectSort,
} from '@/lib/services/contacts';
import { listIndustries } from '@/lib/services/companies';
import { listCampaigns } from '@/lib/services/campaigns';
import { PROSPECT_STATUSES, type ProspectStatus } from '@/lib/db/types';
import { PageHeader, Stat } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button-styles';
import { ProspectsTable } from './prospects-table';
import { ProspectFiltersBar } from './filters-bar';

export const dynamic = 'force-dynamic';

function toArray(value: string | string[] | undefined): string[] | undefined {
  if (!value) return undefined;
  const list = Array.isArray(value) ? value : value.split(',');
  const cleaned = list.map((v) => v.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

export default async function ProspectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireCtx('prospect:read');
  const params = await searchParams;

  const statuses = toArray(params.status)?.filter((s): s is ProspectStatus =>
    (PROSPECT_STATUSES as readonly string[]).includes(s),
  );

  const filters: ProspectFilters = {
    search: typeof params.q === 'string' ? params.q : undefined,
    status: statuses,
    bucket: toArray(params.bucket),
    industry: toArray(params.industry),
    city: toArray(params.city),
    campaignId: typeof params.campaign === 'string' ? params.campaign : undefined,
    minScore: params.minScore ? Number(params.minScore) : undefined,
  };

  const sort = (typeof params.sort === 'string' ? params.sort : 'created_desc') as ProspectSort;
  const page = Number(params.page ?? 1) || 1;

  const [result, industries, cities, campaigns, byStatus] = await Promise.all([
    listProspects(ctx, { filters, sort, page, pageSize: 50 }),
    listIndustries(ctx),
    listCities(ctx),
    listCampaigns(ctx),
    countByStatus(ctx),
  ]);

  const exportParams = new URLSearchParams({ kind: 'prospects' });
  if (filters.search) exportParams.set('search', filters.search);
  if (statuses?.length) exportParams.set('status', statuses.join(','));
  if (filters.bucket?.length) exportParams.set('bucket', filters.bucket.join(','));

  const readyToWork =
    (byStatus.NEW ?? 0) + (byStatus.RESEARCHING ?? 0) + (byStatus.READY ?? 0);

  return (
    <div className="p-6">
      <PageHeader
        title="Prospects"
        subtitle={`${result.total.toLocaleString()} in the database`}
        actions={
          <>
            <a href={`/api/export?${exportParams}`} className={buttonClass('secondary')}>
              Export CSV
            </a>
            <Link href="/prospects/import" className={buttonClass('secondary')}>
              Import
            </Link>
            <Link href="/prospects/new" className={buttonClass('primary')}>
              Add prospect
            </Link>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Not yet worked" value={readyToWork} />
        <Stat label="Contacted" value={byStatus.CONTACTED ?? 0} />
        <Stat label="Replied" value={byStatus.REPLIED ?? 0} tone="positive" />
        <Stat label="Qualified" value={byStatus.QUALIFIED ?? 0} tone="positive" />
        <Stat label="Appointments" value={byStatus.APPOINTMENT ?? 0} tone="hot" />
        <Stat label="Do not contact" value={byStatus.DO_NOT_CONTACT ?? 0} tone="danger" />
      </div>

      <ProspectFiltersBar
        industries={industries}
        cities={cities}
        campaigns={campaigns.map((c) => ({ id: c.campaign.id, name: c.campaign.name }))}
      />

      <ProspectsTable
        rows={result.rows}
        total={result.total}
        page={result.page}
        pageCount={result.pageCount}
        campaigns={campaigns.map((c) => ({ id: c.campaign.id, name: c.campaign.name }))}
        canWrite={ctx.role !== 'VIEWER'}
      />
    </div>
  );
}
