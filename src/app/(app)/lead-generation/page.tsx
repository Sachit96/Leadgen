import Link from 'next/link';
import { requireCtx } from '@/lib/auth/context';
import { listSearchJobs, listSavedSearches, searchOutcome } from '@/lib/services/lead-search';
import { leadViewCounts } from '@/lib/services/leads';
import { discoveryProviderStatus } from '@/lib/lead-generation/providers';
import { Card, PageHeader, SectionTitle, Stat } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button-styles';
import { SearchForm } from './search-form';
import { SearchJobList } from './search-job-list';

export const dynamic = 'force-dynamic';

export default async function LeadGenerationPage() {
  const ctx = await requireCtx('prospect:read');
  // Read, not throw: a misconfigured provider must be reportable on the page
  // that configures it, rather than turning the page into an error screen.
  const provider = discoveryProviderStatus();

  const [jobs, saved, counts] = await Promise.all([
    listSearchJobs(ctx, 25),
    listSavedSearches(ctx),
    leadViewCounts(ctx),
  ]);

  const active = jobs.filter((j) => j.status === 'QUEUED' || j.status === 'RUNNING');
  const outcomes = Object.fromEntries(
    await Promise.all(jobs.slice(0, 10).map(async (job) => [job.id, await searchOutcome(ctx, job.id)] as const)),
  );

  // Run totals, summed from what each run actually produced.
  const scored = Object.values(outcomes).reduce((sum, o) => sum + o.scored, 0);
  const totals = {
    discovered: jobs.reduce((sum, job) => sum + job.discoveredCount, 0),
    duplicates: jobs.reduce((sum, job) => sum + job.duplicateCount, 0),
    crawled: jobs.reduce((sum, job) => sum + job.crawledCount, 0),
    crawlFailed: jobs.reduce((sum, job) => sum + job.crawlFailedCount, 0),
    qualified: Object.values(outcomes).reduce((sum, o) => sum + o.qualified, 0),
    scored,
    // Weighted by how many leads each run scored, so a one-lead run does not
    // move the average as much as a fifty-lead one.
    averageScore:
      scored > 0
        ? Math.round(
            Object.values(outcomes).reduce((sum, o) => sum + o.averageScore * o.scored, 0) / scored,
          )
        : 0,
  };

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

      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Discovered" value={totals.discovered} sublabel={`${jobs.length} runs`} />
        <Stat label="Leads created" value={counts.ALL ?? 0} tone="positive" href="/lead-generation/leads" />
        <Stat label="Duplicates removed" value={totals.duplicates} href="/lead-generation/leads?view=DUPLICATES" />
        <Stat label="Sites crawled" value={totals.crawled} sublabel={`${totals.crawlFailed} would not load`} />
        <Stat
          label="Qualified"
          value={totals.qualified}
          tone={totals.qualified > 0 ? 'hot' : 'neutral'}
          href="/lead-generation/leads?view=CALL_READY"
        />
        <Stat
          label="Average score"
          value={totals.averageScore}
          sublabel={`${totals.scored} scored`}
          tone={totals.averageScore >= 60 ? 'positive' : 'neutral'}
        />
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Enriched" value={counts.ENRICHED ?? 0} href="/lead-generation/leads?view=ENRICHED" />
        <Stat label="Needs review" value={counts.REVIEW ?? 0} tone="warning" href="/lead-generation/leads?view=REVIEW" />
        <Stat label="Approved" value={counts.APPROVED ?? 0} tone="positive" href="/lead-generation/leads?view=APPROVED" />
        <Stat label="Rejected" value={counts.REJECTED ?? 0} href="/lead-generation/leads?view=REJECTED" />
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
              canRun={ctx.role !== 'VIEWER' && provider.ok}
            />
          </Card>

          {provider.ok ? (
            <p className="mt-3 text-xs text-ink-500">
              Source: <span className="text-ink-300">{provider.provider.kind}</span>
              {provider.provider.kind === 'mock'
                ? ' — synthetic data. No real business is contacted, and every generated number is in the 555-01xx range reserved for fiction.'
                : ' — a live provider. Each search calls their API and costs money.'}
            </p>
          ) : (
            <div className="mt-3 rounded-md border border-danger-500/40 bg-danger-500/10 p-3">
              <p className="text-xs font-medium text-danger-400">Lead discovery is not configured</p>
              <p className="mt-1 text-xs text-ink-400">{provider.error}</p>
            </div>
          )}
        </div>

        <div>
          <SectionTitle
            action={
              active.length > 0 ? (
                <span className="text-[11px] text-accent-400">
                  {active.length} run{active.length === 1 ? '' : 's'} in progress
                </span>
              ) : null
            }
          >
            Runs
          </SectionTitle>
          <SearchJobList jobs={jobs} outcomes={outcomes} canWrite={ctx.role !== 'VIEWER'} />
        </div>
      </div>
    </div>
  );
}
