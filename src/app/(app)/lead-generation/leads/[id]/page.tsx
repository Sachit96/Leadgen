import Link from 'next/link';
import { requireCtx } from '@/lib/auth/context';
import { getLeadDetail } from '@/lib/services/leads';
import { listCallHistory } from '@/lib/services/calls';
import { telUri } from '@/lib/providers/call';
import { Badge, Card, KeyValue, Meter, PageHeader, SectionTitle } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button-styles';
import { LeadReviewActions } from './review-actions';
import { LeadDebug } from './debug';

export const dynamic = 'force-dynamic';

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx('prospect:read');
  const { id } = await params;

  const detail = await getLeadDetail(ctx, id);
  const { contact, company, discovery, signals, enrichment, personalization, duplicates } = detail;
  const history = await listCallHistory(ctx, id, 10);

  const detected = signals.filter((s) => s.detected);
  const notDetected = signals.filter((s) => !s.detected);
  const dialable = telUri(contact.phone) !== null;

  return (
    <div className="p-6">
      <PageHeader
        title={company?.name ?? contact.phone}
        subtitle={[company?.industry, company?.city, company?.province].filter(Boolean).join(' · ')}
        actions={
          <>
            <Link href="/lead-generation/leads" className={buttonClass('ghost')}>
              Back to inbox
            </Link>
            <Link href={`/prospects/${contact.id}`} className={buttonClass('secondary')}>
              Open in CRM
            </Link>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
        <div className="space-y-5">
          <Card>
            <SectionTitle>Review</SectionTitle>
            <LeadReviewActions
              contactId={contact.id}
              companyId={company?.id ?? null}
              stage={discovery?.stage ?? null}
              canWrite={ctx.role !== 'VIEWER'}
            />
          </Card>

          {personalization ? (
            <Card>
              <SectionTitle
                action={
                  <Badge tone="accent">confidence {Math.round((personalization.confidence ?? 0) * 100)}%</Badge>
                }
              >
                Opening lines
              </SectionTitle>
              <p className="text-xs uppercase tracking-wider text-ink-500">Hook</p>
              <p className="mt-1 text-sm text-ink-200">{personalization.hook}</p>

              <p className="mt-3 text-xs uppercase tracking-wider text-ink-500">
                SMS opener{personalization.recommendedAngle ? ` · angle ${personalization.recommendedAngle.replace(/_/g, ' ')}` : ''}
              </p>
              <p className="mt-1 whitespace-pre-wrap rounded-md border border-ink-700 bg-ink-900 p-2.5 text-sm text-ink-200">
                {personalization.openingMessage}
              </p>

              <p className="mt-3 text-xs uppercase tracking-wider text-ink-500">Call opener</p>
              <p className="mt-1 whitespace-pre-wrap rounded-md border border-ink-700 bg-ink-900 p-2.5 text-sm text-ink-200">
                {personalization.callOpener}
              </p>
            </Card>
          ) : (
            <Card>
              <SectionTitle>Opening lines</SectionTitle>
              <p className="text-sm text-ink-400">
                Not generated yet. Requeue personalization below once the lead has been researched.
              </p>
            </Card>
          )}

          <Card>
            <SectionTitle>Research</SectionTitle>
            {company?.researchSummary ? (
              <>
                <p className="text-sm text-ink-200">{company.researchSummary}</p>
                {Array.isArray(company.researchPainPoints) && company.researchPainPoints.length > 0 ? (
                  <ul className="mt-3 space-y-1">
                    {(company.researchPainPoints as string[]).map((point) => (
                      <li key={point} className="text-sm text-ink-300">
                        · {point}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="mt-3 text-xs text-ink-500">
                  Research confidence{' '}
                  {company.researchConfidence === null
                    ? 'unrecorded'
                    : `${Math.round(company.researchConfidence * 100)}%`}
                  {company.researchedAt
                    ? ` · ${new Date(company.researchedAt).toLocaleDateString('en-CA')}`
                    : ''}
                </p>
              </>
            ) : (
              <p className="text-sm text-ink-400">No research on file for this business yet.</p>
            )}
          </Card>

          <Card>
            <SectionTitle
              action={<span className="text-[11px] text-ink-500">{detected.length} detected</span>}
            >
              Website signals
            </SectionTitle>
            {signals.length === 0 ? (
              <p className="text-sm text-ink-400">
                Nothing crawled yet, so nothing is claimed either way.
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  {detected.map((signal) => (
                    <div key={signal.id} className="flex items-start justify-between gap-3">
                      <span className="text-sm text-ink-200">
                        {signal.value ?? signal.key.replace(/_/g, ' ')}
                        {signal.inferred ? (
                          <Badge className="ml-1.5" tone="warning">
                            inferred
                          </Badge>
                        ) : null}
                      </span>
                      <span className="max-w-[55%] truncate text-right text-xs text-ink-500">
                        {signal.evidence ?? 'observed'}
                      </span>
                    </div>
                  ))}
                </div>
                {notDetected.length > 0 ? (
                  <p className="mt-3 text-xs text-ink-500">
                    No evidence found for: {notDetected.map((s) => s.key.replace(/_/g, ' ')).join(', ')}.
                    That is not proof they lack it.
                  </p>
                ) : null}
              </>
            )}
          </Card>

          {duplicates.length > 0 ? (
            <Card>
              <SectionTitle>Duplicates matched to this business</SectionTitle>
              <div className="space-y-1.5">
                {duplicates.map((dup) => (
                  <div key={dup.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-ink-200">{dup.reason.replace(/_/g, ' ')}</span>
                    <span className="text-xs text-ink-500">
                      score {dup.score.toFixed(2)} · {describeEvidence(dup.evidence)}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>

        <div className="space-y-5">
          <Card>
            <SectionTitle>Contact</SectionTitle>
            <p className="text-lg font-semibold tabular-nums tracking-tight text-ink-100">
              {contact.phone}
            </p>
            <p className="mt-0.5 text-xs text-ink-500">
              {contact.phoneValidated ? 'Format validated' : 'Format not validated'} · confidence{' '}
              {Math.round((contact.phoneConfidence ?? 0) * 100)}%
              {contact.phoneInvalid ? ' · marked wrong' : ''}
            </p>
            {!dialable ? (
              <p className="mt-2 text-xs text-danger-400">
                This number cannot be dialled from a device.
              </p>
            ) : null}

            <dl className="mt-3 divide-y divide-ink-800">
              <KeyValue label="Owner" value={company?.ownerName ?? '—'} />
              <KeyValue label="Email" value={contact.email ?? '—'} />
              <KeyValue
                label="Website"
                value={
                  company?.website ? (
                    <a
                      href={company.website}
                      target="_blank"
                      rel="noreferrer noopener nofollow"
                      className="text-accent-400 hover:underline"
                    >
                      {company.websiteDomain ?? company.website}
                    </a>
                  ) : (
                    '—'
                  )
                }
              />
              <KeyValue label="Address" value={company?.addressLine ?? '—'} />
              <KeyValue
                label="Google"
                value={
                  company?.googleRating
                    ? `${company.googleRating} · ${company.googleReviews ?? 0} reviews`
                    : '—'
                }
              />
              <KeyValue label="Source" value={company?.discoverySource ?? contact.source ?? '—'} />
            </dl>
          </Card>

          <Card>
            <SectionTitle>Scoring</SectionTitle>
            <div className="space-y-3">
              <Meter
                label="ICP score"
                value={contact.score ?? 0}
                max={100}
                tone={contact.scoreBucket === 'HOT' ? 'hot' : 'accent'}
                caption={contact.scoreBucket ?? 'unscored'}
              />
              <Meter
                label="Data completeness"
                value={company?.dataCompleteness ?? 0}
                max={100}
                tone="neutral"
                caption="%"
              />
              <Meter
                label="Website quality"
                value={company?.websiteQualityScore ?? 0}
                max={100}
                tone="neutral"
                // A null score is "never measured", not zero — say which, rather
                // than showing a 0 next to a quality label it did not produce.
                caption={
                  company?.websiteQualityScore === null || company?.websiteQualityScore === undefined
                    ? 'not scored'
                    : (company.websiteQuality ?? '')
                }
              />
            </div>
          </Card>

          {history.length > 0 ? (
            <Card>
              <SectionTitle>Calls</SectionTitle>
              <div className="space-y-2">
                {history.map((attempt) => (
                  <div key={attempt.id} className="text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-ink-200">{attempt.outcome.replace(/_/g, ' ').toLowerCase()}</span>
                      <span className="text-xs text-ink-500">
                        {new Date(attempt.startedAt).toLocaleString('en-CA')}
                      </span>
                    </div>
                    {attempt.note ? <p className="mt-0.5 text-xs text-ink-400">{attempt.note}</p> : null}
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {ctx.role === 'OWNER' || ctx.role === 'ADMIN' ? (
            <LeadDebug
              discovery={discovery}
              enrichment={enrichment.map((e) => ({
                id: e.id,
                kind: e.kind,
                version: e.version,
                ok: e.ok,
                pagesFetched: e.pagesFetched,
                bytesFetched: e.bytesFetched,
                latencyMs: e.latencyMs,
                errorCode: e.errorCode,
                errorMessage: e.errorMessage,
                createdAt: e.createdAt,
                output: e.output,
              }))}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Duplicate evidence is stored as a JSON bag of the fields that matched. */
function describeEvidence(evidence: unknown): string {
  if (!evidence || typeof evidence !== 'object') return 'no evidence recorded';
  const entries = Object.entries(evidence as Record<string, unknown>)
    .filter(([, value]) => value !== null && value !== '')
    .map(([key, value]) => `${key.replace(/_/g, ' ')}: ${String(value)}`);
  return entries.length > 0 ? entries.join(', ') : 'no evidence recorded';
}
