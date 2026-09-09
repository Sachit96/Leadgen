import Link from 'next/link';
import { requireCtx } from '@/lib/auth/context';
import { listSearchJobs, listSavedSearches } from '@/lib/services/lead-search';
import { leadViewCounts } from '@/lib/services/leads';
import { getDiscoveryProvider } from '@/lib/lead-generation/providers';
import { Card, PageHeader, SectionTitle, Stat } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button-styles';
import { SearchForm } from './search-form';
import { SearchJobList } from './search-job-list';

export const dynamic = 'force-dynamic';

export default async function LeadGenerationPage() {
  const ctx = await requireCtx('prospect:read');
  const provider = getDiscoveryProvider();

  const [jobs, saved, counts] = await Promise.all([
    listSearchJobs(ctx, 25),
    listSavedSearches(ctx),
    leadViewCounts(ctx),
  ]);

  const running = jobs.filter((j) => j.status === 'QUEUED' || j.status === 'RUNNING').length;

  return (
    <div className="p-6">
      <PageHeader
        title="Lead generation"
        subtitle="Search a market, enrich what comes back, review it, then call it."
        actions={
          <Link href="/lead-generation/leads" className={buttonClass('primary')}>
            Lead inbox
          </Link>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Leads" value={counts.ALL ?? 0} href="/lead-generation/leads" />
        <Stat label="Enriched" value={counts.ENRICHED ?? 0} href="/lead-generation/leads?view=ENRICHED" />
        <Stat label="Needs review" value={counts.REVIEW ?? 0} tone="warning" href="/lead-generation/leads?view=REVIEW" />
        <Stat label="Approved" value={counts.APPROVED ?? 0} tone="positive" href="/lead-generation/leads?view=APPROVED" />
        <Stat label="Call ready" value={counts.CALL_READY ?? 0} tone="hot" href="/lead-generation/leads?view=CALL_READY" />
        <Stat label="Duplicates" value={counts.DUPLICATES ?? 0} href="/lead-generation/leads?view=DUPLICATES" />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <div>
          <SectionTitle>New search</SectionTitle>
          <Card>
            <SearchForm
              savedSearches={saved.map((s) => ({
                id: s.id,
                name: s.name,
                query: s.query,
                location: s.location,
                radiusMeters: s.radiusMeters,
              }))}
              canRun={ctx.role !== 'VIEWER'}
            />
          </Card>

          <p className="mt-3 text-xs text-ink-500">
            Source: <span className="text-ink-300">{provider.kind}</span>
            {provider.kind === 'mock'
              ? ' — synthetic data. No real business is contacted, and every generated number is in the 555-01xx range reserved for fiction.'
              : ' — a live provider. Each search calls their API and costs money.'}
          </p>
        </div>

        <div>
          <SectionTitle
            action={
              running > 0 ? (
                <span className="text-[11px] text-accent-400">{running} running</span>
              ) : null
            }
          >
            Searches
          </SectionTitle>
          <SearchJobList jobs={jobs} canWrite={ctx.role !== 'VIEWER'} />
        </div>
      </div>
    </div>
  );
}
