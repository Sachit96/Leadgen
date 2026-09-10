'use client';

import { useState } from 'react';
import { Card, SectionTitle } from '@/components/ui/primitives';
import { Button } from '@/components/ui/buttons';

export type EnrichmentRun = {
  id: string;
  kind: string;
  version: number;
  ok: boolean;
  pagesFetched: number | null;
  bytesFetched: number | null;
  latencyMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  output: unknown;
};

/**
 * The admin view: what the pipeline actually fetched and what it stored.
 *
 * Kept behind a role check and collapsed by default. It exists so a lead that
 * looks wrong can be traced to the crawl that produced it, rather than argued
 * about.
 */
export function LeadDebug({
  discovery,
  enrichment,
}: {
  discovery: Record<string, unknown> | null;
  enrichment: EnrichmentRun[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <SectionTitle
        action={
          <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Show'}
          </Button>
        }
      >
        Pipeline debug
      </SectionTitle>

      {!open ? (
        <p className="text-xs text-ink-500">
          {enrichment.length} enrichment run{enrichment.length === 1 ? '' : 's'} on file.
        </p>
      ) : (
        <div className="space-y-3">
          {enrichment.map((run) => {
            const output = (run.output ?? {}) as {
              pages?: Array<{ url: string; role: string; title: string | null; headings?: string[]; text?: string }>;
              attempts?: Array<{ url: string; outcome: string; status?: number; reason?: string }>;
            };

            return (
              <div key={run.id} className="rounded border border-ink-700 p-2">
                <p className="text-xs text-ink-300">
                  {run.kind} v{run.version} · {run.ok ? 'ok' : 'failed'} ·{' '}
                  {new Date(run.createdAt).toLocaleString('en-CA')}
                </p>
                <p className="mt-0.5 text-[11px] text-ink-500">
                  {run.pagesFetched ?? 0} pages · {run.bytesFetched ?? 0} bytes · {run.latencyMs ?? 0}ms
                  {run.errorCode ? ` · ${run.errorCode}` : ''}
                </p>
                {run.errorMessage ? (
                  <p className="mt-1 text-[11px] text-danger-400">{run.errorMessage}</p>
                ) : null}

                {output.attempts?.length ? (
                  <div className="mt-2">
                    <p className="mb-1 text-[11px] font-medium text-ink-400">URLs considered</p>
                    <ul className="space-y-0.5">
                      {output.attempts.map((attempt) => (
                        <li key={attempt.url} className="flex items-start justify-between gap-2 text-[11px]">
                          <span className="truncate text-ink-400">{attempt.url}</span>
                          <span
                            className={
                              attempt.outcome === 'fetched'
                                ? 'shrink-0 text-positive-400'
                                : attempt.outcome === 'failed'
                                  ? 'shrink-0 text-danger-400'
                                  : 'shrink-0 text-ink-600'
                            }
                          >
                            {attempt.outcome}
                            {attempt.reason ? ` · ${attempt.reason}` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {output.pages?.length ? (
                  <div className="mt-2">
                    <p className="mb-1 text-[11px] font-medium text-ink-400">
                      Content stored ({output.pages.length} pages) — this is what the research agent read
                    </p>
                    {output.pages.map((page) => (
                      <details key={page.url} className="mt-1 rounded bg-ink-900 p-1.5">
                        <summary className="cursor-pointer text-[11px] text-ink-300">
                          <span className="text-ink-500">{page.role}</span> {page.url}
                          <span className="ml-1.5 text-ink-600">
                            {(page.text?.length ?? 0).toLocaleString()} chars
                          </span>
                        </summary>
                        {page.headings?.length ? (
                          <p className="mt-1 text-[11px] text-ink-500">
                            Headings: {page.headings.slice(0, 12).join(' | ')}
                          </p>
                        ) : null}
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-ink-400">
                          {page.text}
                        </pre>
                      </details>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}

          <div>
            <p className="mb-1 text-xs text-ink-300">Discovery record</p>
            <pre className="max-h-64 overflow-auto rounded bg-ink-900 p-2 text-[11px] leading-relaxed text-ink-400">
              {JSON.stringify(discovery, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </Card>
  );
}
