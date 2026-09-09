import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCtx } from '@/lib/auth/context';
import { isAppError } from '@/lib/core/errors';
import {
  getCampaign,
  getCampaignSequence,
  listCampaignMembers,
} from '@/lib/services/campaigns';
import { campaignPerformance, resolveRange, variantPerformance } from '@/lib/services/analytics';
import { formatPhone } from '@/lib/core/phone';
import { formatRelative } from '@/lib/core/time';
import {
  Badge,
  Card,
  PageHeader,
  SectionTitle,
  Stat,
  Table,
  Td,
  Th,
} from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button-styles';
import { CampaignStatusBadge, ProspectStatusBadge } from '@/components/ui/status';
import { SequenceBuilder } from './sequence-builder';
import { CampaignControls } from './controls';
import { CampaignSettingsForm } from './settings-form';

export const dynamic = 'force-dynamic';

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx('campaign:read');

  let campaign;
  try {
    campaign = await getCampaign(ctx, id);
  } catch (error) {
    if (isAppError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const [sequence, members, performance, variants] = await Promise.all([
    getCampaignSequence(ctx, id),
    listCampaignMembers(ctx, id, 25),
    campaignPerformance(ctx, resolveRange('30d')),
    variantPerformance(ctx, id),
  ]);

  const stats = performance.find((p) => p.campaignId === id);
  const canWrite = ctx.role === 'OWNER' || ctx.role === 'ADMIN' || ctx.role === 'SALES_REP';

  return (
    <div className="p-6">
      <PageHeader
        title={campaign.name}
        subtitle={campaign.description ?? undefined}
        actions={
          <>
            <Link href="/campaigns" className={buttonClass('ghost')}>
              ← All campaigns
            </Link>
            <a
              href={`/api/export?kind=campaign_analytics`}
              className={buttonClass('secondary')}
            >
              Export
            </a>
            {canWrite ? (
              <CampaignControls campaignId={campaign.id} status={campaign.status} />
            ) : null}
          </>
        }
      />

      <div className="mb-5 flex items-center gap-2">
        <CampaignStatusBadge status={campaign.status} />
        <span className="text-xs text-ink-500">
          {campaign.sendingWindowStart}–{campaign.sendingWindowEnd} {campaign.timezone} · up to{' '}
          {campaign.dailyCapacity}/day
        </span>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Prospects" value={stats?.prospects ?? 0} />
        <Stat label="Sent" value={stats?.sent ?? 0} />
        <Stat label="Replies" value={stats?.replies ?? 0} tone="positive" />
        <Stat label="Reply rate" value={`${stats?.replyRate ?? 0}%`} />
        <Stat label="Appointments" value={stats?.appointments ?? 0} tone="hot" />
        <Stat
          label="Rev / 100 prospects"
          value={`$${Math.round((stats?.revenuePer100Prospects ?? 0) / 100)}`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <SequenceBuilder campaignId={campaign.id} steps={sequence} canWrite={canWrite} />

          <section>
            <SectionTitle>Variant performance</SectionTitle>
            {variants.length === 0 ? (
              <Card>
                <p className="text-sm text-ink-500">
                  Add message variants to a step to start comparing angles.
                </p>
              </Card>
            ) : (
              <Card padded={false}>
                <Table className="min-w-0">
                  <thead>
                    <tr>
                      <Th>Variant</Th>
                      <Th>Angle</Th>
                      <Th align="right">Sent</Th>
                      <Th align="right">Replies</Th>
                      <Th align="right">Reply rate</Th>
                      <Th align="right">Appointments</Th>
                      <Th>Confidence</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {variants.map((variant) => (
                      <tr key={variant.variantId}>
                        <Td className="text-ink-100">{variant.variantName}</Td>
                        <Td className="text-ink-400">{variant.angle.replace(/_/g, ' ')}</Td>
                        <Td align="right" className="tabular-nums">{variant.messages}</Td>
                        <Td align="right" className="tabular-nums">{variant.replies}</Td>
                        <Td align="right" className="tabular-nums text-ink-100">
                          {variant.replyRate}%
                        </Td>
                        <Td align="right" className="tabular-nums">{variant.appointments}</Td>
                        <Td>
                          {variant.significant ? (
                            <Badge tone="positive">enough data</Badge>
                          ) : (
                            <Badge tone="neutral">too early</Badge>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <p className="border-t border-ink-800 px-4 py-2 text-[11px] text-ink-500">
                  A variant is only marked &ldquo;enough data&rdquo; after 30 sends. Do not scale an
                  arm before then — early reply rates on small samples are noise.
                </p>
              </Card>
            )}
          </section>

          <section>
            <SectionTitle>Prospects in this campaign</SectionTitle>
            {members.length === 0 ? (
              <Card>
                <p className="text-sm text-ink-500">
                  Nobody enrolled yet. Select prospects on the{' '}
                  <Link href="/prospects" className="text-accent-400 hover:underline">
                    prospects page
                  </Link>{' '}
                  and add them to this campaign.
                </p>
              </Card>
            ) : (
              <Card padded={false}>
                <Table>
                  <thead>
                    <tr>
                      <Th>Prospect</Th>
                      <Th>Phone</Th>
                      <Th>Status</Th>
                      <Th>Step</Th>
                      <Th>Next step</Th>
                      <Th>Membership</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {members.map(({ membership, contact, conversationId }) => (
                      <tr key={membership.id}>
                        <Td>
                          <Link
                            href={`/prospects/${contact.id}`}
                            className="text-ink-100 hover:text-accent-400"
                          >
                            {[contact.firstName, contact.lastName].filter(Boolean).join(' ') ||
                              'Unnamed'}
                          </Link>
                        </Td>
                        <Td className="tabular-nums text-ink-300">{formatPhone(contact.phone)}</Td>
                        <Td>
                          <ProspectStatusBadge status={contact.status} />
                        </Td>
                        <Td className="tabular-nums text-ink-400">
                          {membership.currentStepPosition || '—'}
                        </Td>
                        <Td className="text-ink-500">
                          {membership.nextStepAt ? formatRelative(membership.nextStepAt) : '—'}
                        </Td>
                        <Td>
                          <Badge
                            tone={
                              membership.status === 'ACTIVE'
                                ? 'positive'
                                : membership.status === 'PAUSED'
                                  ? 'warning'
                                  : 'neutral'
                            }
                          >
                            {membership.status.toLowerCase()}
                          </Badge>
                          {membership.stoppedReason ? (
                            <p className="mt-0.5 text-[10px] text-ink-500">
                              {membership.stoppedReason}
                            </p>
                          ) : null}
                        </Td>
                        <Td>
                          {conversationId ? (
                            <Link
                              href={`/inbox/${conversationId}`}
                              className="text-xs text-accent-400 hover:underline"
                            >
                              Chat
                            </Link>
                          ) : null}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            )}
          </section>
        </div>

        <div className="space-y-6">
          <section>
            <SectionTitle>Settings</SectionTitle>
            <CampaignSettingsForm campaign={campaign} canWrite={canWrite} />
          </section>

          <section>
            <SectionTitle>How this campaign runs</SectionTitle>
            <Card>
              <ol className="space-y-2 text-xs text-ink-400">
                {[
                  'Prospects are enrolled from the prospects page or on import.',
                  'Step 1 personalizes from researched facts and queues the first message.',
                  'A message only goes out inside the sending window, under the daily cap.',
                  'If they reply, the sequence stops and the AI takes the conversation.',
                  'The AI qualifies, handles objections, and proposes a time.',
                  'Anything it should not answer goes to a human.',
                  'Booking moves the deal and the prospect forward automatically.',
                ].map((line, index) => (
                  <li key={line} className="flex gap-2">
                    <span className="shrink-0 text-ink-600">{index + 1}.</span>
                    <span>{line}</span>
                  </li>
                ))}
              </ol>
            </Card>
          </section>
        </div>
      </div>
    </div>
  );
}
