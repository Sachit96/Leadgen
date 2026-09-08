import Link from 'next/link';
import { requireCtx } from '@/lib/auth/context';
import { listCampaigns } from '@/lib/services/campaigns';
import { campaignPerformance, resolveRange } from '@/lib/services/analytics';
import { formatRelative } from '@/lib/core/time';
import { Card, EmptyState, PageHeader, Table, Td, Th } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/buttons';
import { CampaignStatusBadge } from '@/components/ui/status';
import { WorkerButton } from './worker-button';

export const dynamic = 'force-dynamic';

export default async function CampaignsPage() {
  const ctx = await requireCtx('campaign:read');
  const [campaigns, performance] = await Promise.all([
    listCampaigns(ctx),
    campaignPerformance(ctx, resolveRange('30d')),
  ]);

  const byId = new Map(performance.map((p) => [p.campaignId, p]));
  const canWrite = ctx.role === 'OWNER' || ctx.role === 'ADMIN' || ctx.role === 'SALES_REP';

  return (
    <div className="p-6">
      <PageHeader
        title="Campaigns"
        subtitle="A campaign is an audience, a sequence, and the rules for how it sends."
        actions={
          <>
            {canWrite ? <WorkerButton /> : null}
            {canWrite ? (
              <Link href="/campaigns/new" className={buttonClass('primary')}>
                New campaign
              </Link>
            ) : null}
          </>
        }
      />

      {campaigns.length === 0 ? (
        <EmptyState
          title="No campaigns yet"
          description="A campaign holds your prospects, the message sequence they receive, and the sending rules. The seeded roofing campaign is a good starting point."
          action={
            canWrite ? (
              <Link href="/campaigns/new" className={buttonClass('primary')}>
                Create a campaign
              </Link>
            ) : null
          }
        />
      ) : (
        <Card padded={false}>
          <Table>
            <thead>
              <tr>
                <Th>Campaign</Th>
                <Th>Status</Th>
                <Th align="right">Prospects</Th>
                <Th align="right">Sent</Th>
                <Th align="right">Replies</Th>
                <Th align="right">Reply rate</Th>
                <Th align="right">Appointments</Th>
                <Th align="right">Won</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map(({ campaign, prospects, sent, replies }) => {
                const stats = byId.get(campaign.id);
                return (
                  <tr key={campaign.id} className="hover:bg-ink-850">
                    <Td>
                      <Link
                        href={`/campaigns/${campaign.id}`}
                        className="font-medium text-ink-100 hover:text-accent-400"
                      >
                        {campaign.name}
                      </Link>
                      {campaign.industry ? (
                        <span className="ml-2 text-xs text-ink-500">{campaign.industry}</span>
                      ) : null}
                    </Td>
                    <Td>
                      <CampaignStatusBadge status={campaign.status} />
                    </Td>
                    <Td align="right" className="tabular-nums">{prospects}</Td>
                    <Td align="right" className="tabular-nums">{sent}</Td>
                    <Td align="right" className="tabular-nums">{replies}</Td>
                    <Td align="right" className="tabular-nums text-ink-300">
                      {stats ? `${stats.replyRate}%` : '—'}
                    </Td>
                    <Td align="right" className="tabular-nums">{stats?.appointments ?? 0}</Td>
                    <Td align="right" className="tabular-nums text-positive-400">
                      {stats?.won ?? 0}
                    </Td>
                    <Td className="text-ink-500">{formatRelative(campaign.createdAt)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
