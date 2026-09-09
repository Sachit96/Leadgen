import Link from 'next/link';
import { requireCtx } from '@/lib/auth/context';
import { leadViewCounts, listLeads, type LeadFilters, type LeadView } from '@/lib/services/leads';
import { listCallQueues } from '@/lib/services/call-queue';
import { listCampaigns } from '@/lib/services/campaigns';
import { listIndustries } from '@/lib/services/companies';
import { listCities } from '@/lib/services/contacts';
import { PageHeader } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button-styles';
import { LeadInbox } from './lead-inbox';

export const dynamic = 'force-dynamic';

const VIEWS: Array<{ key: LeadView; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'ENRICHED', label: 'Enriched' },
  { key: 'REVIEW', label: 'Needs review' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'CALL_READY', label: 'Call ready' },
  { key: 'CAMPAIGN_READY', label: 'Campaign ready' },
  { key: 'DUPLICATES', label: 'Duplicates' },
  { key: 'REJECTED', label: 'Rejected' },
];

function toArray(value: string | string[] | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = (Array.isArray(value) ? value : value.split(',')).map((v) => v.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireCtx('prospect:read');
  const params = await searchParams;

  const requested = typeof params.view === 'string' ? params.view : 'ALL';
  const view = (VIEWS.some((v) => v.key === requested) ? requested : 'ALL') as LeadView;

  const filters: LeadFilters = {
    view,
    search: typeof params.q === 'string' ? params.q : undefined,
    minScore: params.minScore ? Number(params.minScore) : undefined,
    industries: toArray(params.industry),
    cities: toArray(params.city),
    searchJobId: typeof params.searchJobId === 'string' ? params.searchJobId : undefined,
    requireOwner: params.requireOwner === '1',
    requireWebsite: params.requireWebsite === '1',
  };

  const page = Number(params.page ?? 1) || 1;

  const [result, counts, industries, cities, queues, campaigns] = await Promise.all([
    listLeads(ctx, { filters, page, pageSize: 50 }),
    leadViewCounts(ctx),
    listIndustries(ctx),
    listCities(ctx),
    listCallQueues(ctx),
    listCampaigns(ctx),
  ]);

  return (
    <div className="p-6">
      <PageHeader
        title="Lead inbox"
        subtitle={`${result.total.toLocaleString()} leads in this view — every one of them is a prospect in the CRM`}
        actions={
          <>
            <Link href="/lead-generation" className={buttonClass('secondary')}>
              Searches
            </Link>
            <Link href="/calls" className={buttonClass('primary')}>
              Call queues
            </Link>
          </>
        }
      />

      <LeadInbox
        views={VIEWS.map((v) => ({ ...v, count: counts[v.key] ?? 0 }))}
        activeView={view}
        rows={result.rows}
        total={result.total}
        page={result.page}
        pageCount={result.pageCount}
        industries={industries}
        cities={cities}
        queues={queues.map((q) => ({ id: q.queue.id, name: q.queue.name }))}
        campaigns={campaigns
          .filter((c) => c.campaign.status === 'ACTIVE' || c.campaign.status === 'DRAFT')
          .map((c) => ({ id: c.campaign.id, name: c.campaign.name }))}
        canWrite={ctx.role !== 'VIEWER'}
      />
    </div>
  );
}
