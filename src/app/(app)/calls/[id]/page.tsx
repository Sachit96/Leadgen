import Link from 'next/link';
import { requireCtx } from '@/lib/auth/context';
import { currentQueuePosition, getCallQueue, loadCallCard } from '@/lib/services/call-queue';
import { getCallProvider, telUri } from '@/lib/providers/call';
import { Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button-styles';
import { CallView } from './call-view';

export const dynamic = 'force-dynamic';

export default async function CallQueuePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx('prospect:read');
  const { id } = await params;

  const queue = await getCallQueue(ctx, id);
  const position = await currentQueuePosition(ctx, id);

  if (!position) {
    return (
      <div className="p-6">
        <PageHeader
          title={queue.name}
          subtitle={`${queue.completedCount} called, ${queue.skippedCount} skipped`}
          actions={
            <Link href="/calls" className={buttonClass('secondary')}>
              All queues
            </Link>
          }
        />
        <Card>
          <EmptyState
            title={queue.totalCount === 0 ? 'This queue is empty' : 'Queue finished'}
            description={
              queue.totalCount === 0
                ? 'Nothing matched the filters when this queue was built. Top it up from the queues page once more leads are call-ready.'
                : 'Every lead in this queue has been called or skipped. Top it up to add newly call-ready leads.'
            }
            action={
              <Link href="/calls" className={buttonClass('primary')}>
                Back to queues
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  const card = await loadCallCard(ctx, position.contactId);
  const provider = getCallProvider();

  return (
    <CallView
      queue={{ id: queue.id, name: queue.name }}
      position={position}
      card={{
        contactId: card.contact.id,
        phone: card.contact.phone,
        dialUri: telUri(card.contact.phone),
        contactName: [card.contact.firstName, card.contact.lastName].filter(Boolean).join(' ') || null,
        score: card.contact.score,
        scoreBucket: card.contact.scoreBucket,
        phoneConfidence: card.contact.phoneConfidence,
        phoneValidated: card.contact.phoneValidated,
        callAttemptCount: card.contact.callAttemptCount,
        noAnswerCount: card.contact.noAnswerCount,
        companyName: card.company?.name ?? null,
        category: card.company?.industry ?? null,
        city: card.company?.city ?? null,
        province: card.company?.province ?? null,
        addressLine: card.company?.addressLine ?? null,
        website: card.company?.website ?? null,
        websiteDomain: card.company?.websiteDomain ?? null,
        rating: card.company?.googleRating ?? null,
        reviews: card.company?.googleReviews ?? null,
        ownerName: card.company?.ownerName ?? null,
        researchSummary: card.company?.researchSummary ?? null,
        painPoints: (card.company?.researchPainPoints as string[] | null) ?? [],
        dataCompleteness: card.company?.dataCompleteness ?? null,
        callOpener: card.personalization?.callOpener ?? null,
        hook: card.personalization?.hook ?? null,
        history: card.history.map((h) => ({
          id: h.id,
          outcome: h.outcome,
          note: h.note,
          startedAt: h.startedAt.toISOString(),
          connectionReported: h.connectionReported,
        })),
      }}
      providerReportsConnection={provider.reportsConnection}
      canCall={ctx.role !== 'VIEWER'}
    />
  );
}
