import { requireCtx } from '@/lib/auth/context';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { memberships, phoneNumbers, users } from '@/lib/db/schema';
import { getOrgConfig } from '@/lib/services/settings';
import { listDeadJobs, queueStats } from '@/lib/services/queue';
import { listSuppression } from '@/lib/services/suppression';
import { integrationStatus } from '@/lib/env';
import { PageHeader } from '@/components/ui/primitives';
import { SettingsTabs } from './tabs';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const ctx = await requireCtx();
  const db = getDb();

  const [config, queue, deadJobs, suppression, team, numbers] = await Promise.all([
    getOrgConfig(ctx),
    queueStats(ctx),
    listDeadJobs(ctx, 25),
    listSuppression(ctx, 100),
    db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.organizationId, ctx.organizationId)),
    db.select().from(phoneNumbers).where(eq(phoneNumbers.organizationId, ctx.organizationId)),
  ]);

  return (
    <div className="p-6">
      <PageHeader title="Settings" subtitle="Offer, sending guardrails, scoring, integrations and team." />
      <SettingsTabs
        config={config}
        integrations={integrationStatus()}
        queue={queue}
        deadJobs={deadJobs.map((job) => ({
          id: job.id,
          lastError: job.lastError,
          attempts: job.attempts,
          completedAt: job.completedAt?.toISOString() ?? null,
        }))}
        suppression={suppression.map((entry) => ({
          id: entry.id,
          phone: entry.phone,
          reason: entry.reason,
          note: entry.note,
          createdAt: entry.createdAt.toISOString(),
        }))}
        team={team}
        numbers={numbers.map((number) => ({
          id: number.id,
          number: number.number,
          label: number.label,
          active: number.active,
          dailyCap: number.dailyCap,
        }))}
        canWrite={ctx.role === 'OWNER' || ctx.role === 'ADMIN'}
        role={ctx.role}
      />
    </div>
  );
}
