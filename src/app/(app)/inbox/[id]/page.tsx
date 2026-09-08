import { notFound } from 'next/navigation';
import { isAppError } from '@/lib/core/errors';
import { requireCtx } from '@/lib/auth/context';
import {
  getConversation,
  latestSummary,
  markRead,
} from '@/lib/services/conversations';
import { listMessages } from '@/lib/services/messages';
import { listActivityForContact } from '@/lib/services/activity';
import {
  DEFAULT_QUALIFICATION_FIELDS,
  getQualification,
  parseFields,
} from '@/lib/services/qualification';
import { availability } from '@/lib/services/appointments';
import { buildPersonalizationContext } from '@/lib/services/personalization';
import { ConversationWorkspace } from './workspace';

export const dynamic = 'force-dynamic';

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx('conversation:read');

  let data;
  try {
    data = await getConversation(ctx, id);
  } catch (error) {
    if (isAppError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const [messages, summary, qualification, activity, slots, personalization] = await Promise.all([
    listMessages(ctx, id),
    latestSummary(ctx, id),
    getQualification(ctx, id),
    listActivityForContact(ctx, data.contact.id, 40),
    availability(ctx, { days: 5, limit: 8 }),
    buildPersonalizationContext(ctx, data.contact.id),
  ]);

  // Opening a conversation is reading it.
  await markRead(ctx, id);

  return (
    <ConversationWorkspace
      conversation={data.conversation}
      contact={data.contact}
      company={data.company}
      campaignName={data.campaign?.name ?? null}
      messages={messages}
      summary={summary}
      qualificationFields={parseFields(qualification?.fields)}
      qualificationDefinitions={DEFAULT_QUALIFICATION_FIELDS}
      completeness={qualification?.completeness ?? 0}
      activity={activity}
      slots={slots.map((s) => ({ startsAt: s.startsAt.toISOString(), label: s.label }))}
      facts={personalization.facts}
      unknowns={personalization.unknowns}
      canWrite={ctx.role !== 'VIEWER'}
    />
  );
}
