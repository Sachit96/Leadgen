import Link from 'next/link';
import { requireCtx } from '@/lib/auth/context';
import {
  callOutcomeBreakdown,
  callsDailySeries,
  campaignPerformance,
  dailySeries,
  funnelMetrics,
  leadFunnel,
  resolveRange,
  revenueBySource,
  variantPerformance,
} from '@/lib/services/analytics';
import { callMetrics } from '@/lib/services/calls';
import { getCallProvider } from '@/lib/providers/call';
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
import { buttonClass } from '@/components/ui/button-styles';
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

  const [metrics, series, campaigns, variants, sources, config, leads, calls, callSeries, outcomes] =
    await Promise.all([
      funnelMetrics(ctx, range),
      dailySeries(ctx, range),
      campaignPerformance(ctx, range),
      variantPerformance(ctx),
      revenueBySource(ctx),
      getOrgConfig(ctx),
      leadFunnel(ctx, range),
      callMetrics(ctx, range.from),
      callsDailySeries(ctx, range),
      callOutcomeBreakdown(ctx, range),
    ]);

  const currency = config.offer.currency;
  const callProvider = getCallProvider();

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

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <div>
          <SectionTitle>Lead generation</SectionTitle>
          <Card>
            <FunnelChart
              stages={[
                { label: 'Discovered', value: leads.discovered },
                { label: 'Promoted to CRM', value: leads.promoted, rateLabel: 'of discovered' },
                { label: 'Site crawled', value: leads.crawled, rateLabel: 'of promoted' },
                { label: 'Researched', value: leads.researched, rateLabel: 'of crawled' },
                { label: 'Scored', value: leads.scored, rateLabel: 'of researched' },
                { label: 'Opening line written', value: leads.personalized, rateLabel: 'of scored' },
                { label: 'Call ready', value: leads.callReady, rateLabel: 'of scored' },
                { label: 'Called', value: leads.called, rateLabel: 'of call ready' },
              ]}
            />
            <p className="mt-3 text-xs text-ink-500">
              {leads.searches} search{leads.searches === 1 ? '' : 'es'} · {leads.duplicates} duplicates
              skipped · {leads.failed} records failed enrichment.
            </p>
          </Card>
        </div>

        <div>
          <SectionTitle>Calling</SectionTitle>
          <Card>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Calls started" value={calls.attempted} />
              <Stat label="Outcomes marked" value={calls.dispositioned} />
              <Stat label="Booked" value={calls.booked} tone="positive" />
              <Stat label="Bookings per 100" value={calls.bookingsPer100Calls} tone="hot" />
            </div>
            <div className="mt-3">
              <BarChart
                bars={outcomes.map((o) => ({
                  label: o.outcome.replace(/_/g, ' ').toLowerCase(),
                  value: o.count,
                }))}
              />
            </div>
          </Card>
        </div>

        <div>
          <SectionTitle>What the call data is</SectionTitle>
          <Card className="space-y-3">
            <Stat
              label={calls.connectRateObservable ? 'Connect rate' : 'Operator-reported contact rate'}
              value={`${calls.operatorReportedContactRate}%`}
              sublabel={`${calls.dispositioned} outcomes marked`}
            />
            <p className="text-xs leading-relaxed text-ink-500">
              {callProvider.reportsConnection
                ? 'Your call provider reports call progress, so connect data here is measured telemetry.'
                : 'Calls are placed by the operator\u2019s phone through a tel: link. The app records that a call was started and whatever outcome the operator marked \u2014 it never observes whether a call connected, so there is no measured connect rate to publish.'}
            </p>
            <p className="text-xs leading-relaxed text-ink-500">
              {calls.reportedConnected > 0
                ? `${calls.reportedConnected} calls were reported connected by a provider.`
                : 'No call in this range was reported connected by a provider.'}
            </p>
          </Card>
        </div>
      </div>

      {callSeries.length > 0 ? (
        <div className="mt-6">
          <SectionTitle>Calls over time</SectionTitle>
          <Card>
            <LineChart
              title="Calls started, outcomes marked and bookings per day"
              points={callSeries.map((point) => ({
                label: point.day,
                values: {
                  started: point.started,
                  dispositioned: point.dispositioned,
                  booked: point.booked,
                },
              }))}
              series={[
                { key: 'started', label: 'Started' },
                { key: 'dispositioned', label: 'Marked' },
                { key: 'booked', label: 'Booked' },
              ]}
            />
          </Card>
        </div>
      ) : null}

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
