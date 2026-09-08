import { requireCtx } from '@/lib/auth/context';
import { desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { aiRuns } from '@/lib/db/schema';
import { listPrompts, DEFAULT_PROMPTS } from '@/lib/agents/prompts';
import { listKnowledge, listObjections } from '@/lib/services/knowledge';
import { getOrgConfig } from '@/lib/services/settings';
import { integrationStatus } from '@/lib/env';
import { formatRelative } from '@/lib/core/time';
import { Badge, Card, PageHeader, Stat } from '@/components/ui/primitives';
import { AiWorkbench } from './workbench';

export const dynamic = 'force-dynamic';

export default async function AiPage() {
  const ctx = await requireCtx('analytics:read');
  const db = getDb();

  const [prompts, knowledge, objections, config, runStats, recentRuns] = await Promise.all([
    listPrompts(ctx),
    listKnowledge(ctx),
    listObjections(ctx),
    getOrgConfig(ctx),
    db
      .select({
        total: sql<number>`count(*)::int`,
        failures: sql<number>`count(*) filter (where ${aiRuns.ok} = false)::int`,
        costCents: sql<number>`coalesce(sum(${aiRuns.costCents}), 0)::int`,
        avgLatency: sql<number>`coalesce(round(avg(${aiRuns.latencyMs})), 0)::int`,
      })
      .from(aiRuns)
      .where(eq(aiRuns.organizationId, ctx.organizationId)),
    db
      .select()
      .from(aiRuns)
      .where(eq(aiRuns.organizationId, ctx.organizationId))
      .orderBy(desc(aiRuns.createdAt))
      .limit(20),
  ]);

  const stats = runStats[0] ?? { total: 0, failures: 0, costCents: 0, avgLatency: 0 };
  const integrations = integrationStatus();
  const successRate = stats.total > 0 ? Math.round(((stats.total - stats.failures) / stats.total) * 100) : 100;

  return (
    <div className="p-6">
      <PageHeader
        title="AI"
        subtitle={`${config.ai.agentName} · ${
          integrations.ai.effective === 'anthropic'
            ? 'connected to Anthropic'
            : 'running in mock mode — set ANTHROPIC_API_KEY to use a real model'
        }`}
      />

      {integrations.ai.effective === 'mock' ? (
        <Card className="mb-5 border-warning-500/40 bg-warning-500/5">
          <p className="text-sm text-warning-400">
            The AI provider is not configured, so the agent returns deterministic mock replies.
            Conversations, validation, handoff and logging all work exactly as they will in
            production — only the model is stubbed.
          </p>
        </Card>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="AI runs" value={stats.total} />
        <Stat
          label="Success rate"
          value={`${successRate}%`}
          tone={successRate >= 95 ? 'positive' : successRate >= 80 ? 'warning' : 'danger'}
          sublabel={`${stats.failures} failed`}
        />
        <Stat label="Avg latency" value={`${stats.avgLatency}ms`} />
        <Stat label="Estimated cost" value={`$${(stats.costCents / 100).toFixed(2)}`} />
      </div>

      <AiWorkbench
        prompts={prompts.map((prompt) => ({
          id: prompt.id,
          agentType: prompt.agentType,
          name: prompt.name,
          version: prompt.version,
          prompt: prompt.prompt,
          active: prompt.active,
          createdAt: prompt.createdAt.toISOString(),
        }))}
        defaults={Object.fromEntries(
          Object.entries(DEFAULT_PROMPTS).map(([key, value]) => [key, value.prompt]),
        )}
        knowledge={knowledge.map((entry) => ({
          id: entry.id,
          category: entry.category,
          title: entry.title,
          content: entry.content,
        }))}
        objections={objections.map((objection) => ({
          id: objection.id,
          trigger: objection.trigger,
          matchers: (objection.matchers as string[]) ?? [],
          strategy: objection.strategy,
          exampleResponses: (objection.exampleResponses as string[]) ?? [],
        }))}
        ai={config.ai}
        canWrite={ctx.role === 'OWNER' || ctx.role === 'ADMIN'}
      />

      <section className="mt-6">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-400">
          Recent AI runs
        </h2>
        <Card padded={false}>
          <ul className="divide-y divide-ink-800">
            {recentRuns.length === 0 ? (
              <li className="px-4 py-3 text-sm text-ink-500">No AI runs recorded yet.</li>
            ) : (
              recentRuns.map((run) => (
                <li key={run.id} className="flex items-center gap-3 px-4 py-2">
                  <Badge tone={run.ok ? 'positive' : 'danger'}>{run.ok ? 'ok' : 'failed'}</Badge>
                  <span className="text-xs text-ink-200">{run.agentType}</span>
                  <span className="text-[11px] text-ink-500">{run.promptVersion}</span>
                  <span className="text-[11px] text-ink-600">{run.model}</span>
                  <span className="text-[11px] text-ink-600">{run.tier}</span>
                  {run.errorMessage ? (
                    <span className="truncate text-[11px] text-danger-400">{run.errorMessage}</span>
                  ) : null}
                  <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-500">
                    {run.latencyMs ? `${run.latencyMs}ms · ` : ''}
                    {formatRelative(run.createdAt)}
                  </span>
                </li>
              ))
            )}
          </ul>
        </Card>
      </section>
    </div>
  );
}
