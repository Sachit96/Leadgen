import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCtx } from '@/lib/auth/context';
import { isAppError } from '@/lib/core/errors';
import { getProspect } from '@/lib/services/contacts';
import { listActivityForContact } from '@/lib/services/activity';
import { buildPersonalizationContext } from '@/lib/services/personalization';
import { formatPhone } from '@/lib/core/phone';
import { formatRelative } from '@/lib/core/time';
import { Card, PageHeader, SectionTitle, cn } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/buttons';
import { ProspectStatusBadge, ScoreBadge } from '@/components/ui/status';
import { ProspectEditor } from './editor';

export const dynamic = 'force-dynamic';

type ScoreLine = { key: string; label: string; points: number; awarded: boolean; reason: string };

export default async function ProspectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx('prospect:read');

  let data;
  try {
    data = await getProspect(ctx, id);
  } catch (error) {
    if (isAppError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const [activity, personalization] = await Promise.all([
    listActivityForContact(ctx, id, 60),
    buildPersonalizationContext(ctx, id),
  ]);

  const { contact, company, conversation } = data;
  const breakdown = (contact.scoreBreakdown as ScoreLine[]) ?? [];
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Unnamed contact';

  return (
    <div className="p-6">
      <PageHeader
        title={company?.name ?? name}
        subtitle={`${name} · ${formatPhone(contact.phone)}${company?.city ? ` · ${company.city}` : ''}`}
        actions={
          <>
            <Link href="/prospects" className={buttonClass('ghost')}>
              ← All prospects
            </Link>
            {conversation ? (
              <Link href={`/inbox/${conversation.id}`} className={buttonClass('primary')}>
                Open conversation
              </Link>
            ) : null}
          </>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <ProspectStatusBadge status={contact.status} />
        <ScoreBadge score={contact.score} bucket={contact.scoreBucket} />
        {contact.scoredAt ? (
          <span className="text-xs text-ink-500">
            scored {formatRelative(contact.scoredAt)} · {contact.scoringVersion}
          </span>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <ProspectEditor
            contact={contact}
            company={company}
            canWrite={ctx.role !== 'VIEWER'}
          />

          <section>
            <SectionTitle>Why this score</SectionTitle>
            {breakdown.length === 0 ? (
              <Card>
                <p className="text-sm text-ink-500">
                  This prospect has not been scored yet. Add company research and save to score it.
                </p>
              </Card>
            ) : (
              <Card padded={false}>
                <ul className="divide-y divide-ink-800">
                  {breakdown.map((line) => (
                    <li key={line.key} className="flex items-start gap-3 px-4 py-2.5">
                      <span
                        className={cn(
                          'mt-0.5 w-10 shrink-0 text-right text-xs font-semibold tabular-nums',
                          line.awarded ? 'text-positive-400' : 'text-ink-600',
                        )}
                      >
                        {line.awarded ? `+${line.points}` : '—'}
                      </span>
                      <div className="min-w-0">
                        <p
                          className={cn(
                            'text-sm',
                            line.awarded ? 'text-ink-100' : 'text-ink-500',
                          )}
                        >
                          {line.label}
                        </p>
                        <p className="text-xs text-ink-500">{line.reason}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </section>
        </div>

        <div className="space-y-6">
          <section>
            <SectionTitle>Research</SectionTitle>
            <Card>
              {company?.researchSummary ? (
                <>
                  <p className="text-sm leading-relaxed text-ink-200">{company.researchSummary}</p>
                  {Array.isArray(company.researchPainPoints) &&
                  (company.researchPainPoints as string[]).length > 0 ? (
                    <ul className="mt-3 space-y-1">
                      {(company.researchPainPoints as string[]).map((pain) => (
                        <li key={pain} className="text-xs text-ink-400">
                          · {pain}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="mt-3 text-xs text-ink-500">
                    Confidence {Math.round((company.researchConfidence ?? 0) * 100)}% ·{' '}
                    {formatRelative(company.researchedAt)}
                  </p>
                </>
              ) : (
                <p className="text-sm text-ink-500">
                  No research yet. Run research to generate a summary, likely pain points and a
                  personalization hook from what is on file.
                </p>
              )}
            </Card>
          </section>

          <section>
            <SectionTitle>Personalization</SectionTitle>
            <Card>
              <p className="text-xs font-medium text-ink-300">Hook</p>
              <p className="mt-1 text-sm text-ink-200">
                {personalization.hook ?? (
                  <span className="text-ink-500">
                    None available — the first message would be blocked rather than sent with a gap.
                  </span>
                )}
              </p>

              <p className="mt-3 text-xs font-medium text-ink-300">Verified facts</p>
              <ul className="mt-1 space-y-0.5">
                {personalization.facts.map((fact) => (
                  <li key={fact} className="text-xs text-ink-400">
                    · {fact}
                  </li>
                ))}
              </ul>

              {personalization.unknowns.length > 0 ? (
                <p className="mt-3 border-t border-ink-800 pt-2 text-[11px] text-ink-500">
                  Unknown, never asserted: {personalization.unknowns.join(', ')}
                </p>
              ) : null}
            </Card>
          </section>

          <section>
            <SectionTitle>Timeline</SectionTitle>
            <Card padded={false}>
              <ol className="max-h-96 divide-y divide-ink-800 overflow-y-auto">
                {activity.length === 0 ? (
                  <li className="px-4 py-3 text-sm text-ink-500">Nothing recorded yet.</li>
                ) : (
                  activity.map((item) => (
                    <li key={item.id} className="px-4 py-2.5">
                      <p className="text-xs text-ink-200">{item.title}</p>
                      {item.body ? (
                        <p className="mt-0.5 line-clamp-2 text-[11px] text-ink-500">{item.body}</p>
                      ) : null}
                      <p className="mt-0.5 text-[10px] text-ink-600">
                        {formatRelative(item.createdAt)} · {item.actorKind}
                      </p>
                    </li>
                  ))
                )}
              </ol>
            </Card>
          </section>
        </div>
      </div>
    </div>
  );
}
