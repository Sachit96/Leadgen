import Link from 'next/link';
import { requireCtx } from '@/lib/auth/context';
import {
  campaignPerformance,
  dailySeries,
  funnelMetrics,
  resolveRange,
  revenueBySource,
  variantPerformance,
} from '@/lib/services/analytics';
import { formatMoney, getOrgConfig } from '@/lib/services/settings';
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
import { buttonClass } from '@/components/ui/buttons';
import { BarChart, FunnelChart, LineChart } from '@/components/ui/charts';
import { RangePicker } from './range-picker';

export const dynamic = 'force-dynamic';

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireCtx('analytics:read');
  const params = await searchParams;

  const preset = typeof params.range === 'string' ? params.range : '30d';
  const range = resolveRange(preset, {
    from: typeof params.from === 'string' ? params.from : undefined,
    to: typeof params.to === 'string' ? params.to : undefined,
  });

  const [metrics, series, campaigns, variants, sources, config] = await Promise.all([
    funnelMetrics(ctx, range),
    dailySeries(ctx, range),
    campaignPerformance(ctx, range),
    variantPerformance(ctx),
    revenueBySource(ctx),
    getOrgConfig(ctx),
  ]);

  const currency = config.offer.currency;

  return (
    <div className="p-6">
      <PageHeader
        title="Analytics"
        subtitle={`${range.label} · ${range.from.toLocaleDateString('en-CA')} to ${range.to.toLocaleDateString('en-CA')}`}
        actions={
          <>
            <RangePicker current={preset} />
            <a
              href={`/api/export?kind=campaign_analytics&range=${preset}`}
              className={buttonClass('secondary')}
            >
              Export
            </a>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat label="Prospects contacted" value={metrics.prospectsContacted} />
        <Stat label="Messages sent" value={metrics.sent} sublabel={`${metrics.deliveryRate}% delivered`} />
        <Stat label="Reply rate" value={`${metrics.replyRate}%`} tone="positive" sublabel={`${metrics.replies} replied`} />
        <Stat
          label="Positive reply rate"
          value={`${metrics.positiveReplyRate}%`}
          sublabel={`${metrics.positiveReplies} positive`}
        />
        <Stat label="Appointments" value={metrics.appointments} tone="hot" sublabel={`${metrics.showRate}% showed`} />
        <Stat
          label="Revenue"
          value={formatMoney(metrics.revenueCents, currency)}
          tone={metrics.revenueCents > 0 ? 'positive' : 'neutral'}
          sublabel={`${metrics.won} won`}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SectionTitle>Volume over time</SectionTitle>
          <Card>
            <LineChart
              title="Messages, replies and appointments per day"
              points={series.map((point) => ({
                label: point.day,
                values: {
                  sent: point.sent,
                  delivered: point.delivered,
                  replies: point.replies,
                  appointments: point.appointments,
                },
              }))}
              series={[
                { key: 'sent', label: 'Sent' },
                { key: 'delivered', label: 'Delivered' },
                { key: 'replies', label: 'Replies' },
                { key: 'appointments', label: 'Appointments' },
              ]}
            />
          </Card>
        </div>

        <div>
          <SectionTitle>Funnel</SectionTitle>
          <Card>
            <FunnelChart
              stages={[
                { label: 'Contacted', value: metrics.prospectsContacted },
                { label: 'Delivered', value: metrics.delivered, rate: metrics.deliveryRate, rateLabel: 'of sent' },
                { label: 'Replied', value: metrics.replies, rate: metrics.replyRate, rateLabel: 'of contacted' },
                { label: 'Qualified', value: metrics.qualified, rate: metrics.qualificationRate, rateLabel: 'of replies' },
                { label: 'Appointments', value: metrics.appointments, rate: metrics.bookingRate, rateLabel: 'of qualified' },
                { label: 'Showed', value: metrics.appointmentsShowed, rate: metrics.showRate, rateLabel: 'of booked' },
                { label: 'Won', value: metrics.won, rate: metrics.closeRate, rateLabel: 'of opportunities' },
              ]}
            />
          </Card>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle>Revenue efficiency</SectionTitle>
          <Card className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Stat
                label="Revenue per 100 prospects"
                value={formatMoney(metrics.revenuePer100Prospects, currency)}
              />
              <Stat
                label="Revenue per appointment"
                value={formatMoney(
                  metrics.appointments > 0 ? Math.round(metrics.revenueCents / metrics.appointments) : 0,
                  currency,
                )}
              />
            </div>
            <p className="text-xs text-ink-500">
              Revenue is attributed back through the deal to the conversation, the campaign, and the
              message variant that opened it — so these numbers answer &ldquo;which message made
              money&rdquo;, not just &ldquo;how much came in&rdquo;.
            </p>
            {metrics.recurringRevenueCents > 0 ? (
              <p className="text-xs text-ink-400">
                Plus {formatMoney(metrics.recurringRevenueCents, currency)} in recurring value on won
                deals.
              </p>
            ) : null}
          </Card>
        </div>

        <div>
          <SectionTitle>Revenue by prospect source</SectionTitle>
          <Card>
            <BarChart
              bars={sources
                .filter((s) => s.prospects > 0)
                .map((source) => ({
                  label: source.source,
                  value: source.revenueCents,
                  sublabel: `${source.prospects} prospects`,
                }))}
              valueFormat={(value) => formatMoney(value, currency)}
            />
          </Card>
        </div>
      </div>

      <div className="mt-6">
        <SectionTitle>Campaign performance</SectionTitle>
        {campaigns.length === 0 ? (
          <Card>
            <p className="text-sm text-ink-500">No campaigns yet.</p>
          </Card>
        ) : (
          <Card padded={false}>
            <Table>
              <thead>
                <tr>
                  <Th>Campaign</Th>
                  <Th align="right">Prospects</Th>
                  <Th align="right">Sent</Th>
                  <Th align="right">Delivered</Th>
                  <Th align="right">Replies</Th>
                  <Th align="right">Reply rate</Th>
                  <Th align="right">Appointments</Th>
                  <Th align="right">Booking rate</Th>
                  <Th align="right">Won</Th>
                  <Th align="right">Revenue</Th>
                  <Th align="right">Rev / 100</Th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign) => (
                  <tr key={campaign.campaignId} className="hover:bg-ink-850">
                    <Td>
                      <Link
                        href={`/campaigns/${campaign.campaignId}`}
                        className="text-ink-100 hover:text-accent-400"
                      >
                        {campaign.campaignName}
                      </Link>
                    </Td>
                    <Td align="right" className="tabular-nums">{campaign.prospects}</Td>
                    <Td align="right" className="tabular-nums">{campaign.sent}</Td>
                    <Td align="right" className="tabular-nums">{campaign.delivered}</Td>
                    <Td align="right" className="tabular-nums">{campaign.replies}</Td>
                    <Td align="right" className="tabular-nums text-ink-100">{campaign.replyRate}%</Td>
                    <Td align="right" className="tabular-nums">{campaign.appointments}</Td>
                    <Td align="right" className="tabular-nums">{campaign.bookingRate}%</Td>
                    <Td align="right" className="tabular-nums text-positive-400">{campaign.won}</Td>
                    <Td align="right" className="tabular-nums">
                      {formatMoney(campaign.revenueCents, currency)}
                    </Td>
                    <Td align="right" className="tabular-nums text-ink-300">
                      {formatMoney(campaign.revenuePer100Prospects, currency)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}
      </div>

      <div className="mt-6">
        <SectionTitle>Message variants — A/B results</SectionTitle>
        {variants.length === 0 ? (
          <Card>
            <p className="text-sm text-ink-500">No variants have sent yet.</p>
          </Card>
        ) : (
          <Card padded={false}>
            <Table>
              <thead>
                <tr>
                  <Th>Campaign</Th>
                  <Th>Variant</Th>
                  <Th>Angle</Th>
                  <Th align="right">Sent</Th>
                  <Th align="right">Replies</Th>
                  <Th align="right">Reply rate</Th>
                  <Th align="right">Positive</Th>
                  <Th align="right">Qualified</Th>
                  <Th align="right">Appointments</Th>
                  <Th align="right">Revenue</Th>
                  <Th>Sample</Th>
                </tr>
              </thead>
              <tbody>
                {variants.map((variant) => (
                  <tr key={variant.variantId} className="hover:bg-ink-850">
                    <Td className="text-ink-400">{variant.campaignName}</Td>
                    <Td className="text-ink-100">{variant.variantName}</Td>
                    <Td className="text-ink-400">{variant.angle.replace(/_/g, ' ')}</Td>
                    <Td align="right" className="tabular-nums">{variant.messages}</Td>
                    <Td align="right" className="tabular-nums">{variant.replies}</Td>
                    <Td align="right" className="tabular-nums text-ink-100">{variant.replyRate}%</Td>
                    <Td align="right" className="tabular-nums">{variant.positiveReplies}</Td>
                    <Td align="right" className="tabular-nums">{variant.qualified}</Td>
                    <Td align="right" className="tabular-nums">{variant.appointments}</Td>
                    <Td align="right" className="tabular-nums">
                      {formatMoney(variant.revenueCents, currency)}
                    </Td>
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
              Variants stay marked &ldquo;too early&rdquo; until 30 sends. A reply rate from a
              handful of messages is noise, and scaling on it is how a good angle gets killed.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}
