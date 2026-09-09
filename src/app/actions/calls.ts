'use server';

import { requireCtx } from '@/lib/auth/context';
import { invalid } from '@/lib/core/errors';
import {
  addToQueue,
  buildQueueFromFilters,
  createCallQueue,
  markItemCurrent,
  removeFromQueue,
  setQueueStatus,
  skipQueueItem,
  type QueueFilters,
} from '@/lib/services/call-queue';
import { addCallNote, initiateCall, recordDisposition } from '@/lib/services/calls';
import type { CallOutcome, CallQueueStatus } from '@/lib/db/types';
import { CALL_OUTCOMES } from '@/lib/db/types';
import { action, list, num, optionalNum, optionalStr, str } from './helpers';

const CALL_PATHS = ['/calls', '/prospects', '/'];

export async function createCallQueueAction(form: FormData) {
  return action(
    'calls.createQueue',
    async () => {
      const ctx = await requireCtx('prospect:write');
      const filters: QueueFilters = {
        minScore: optionalNum(form, 'minScore') ?? undefined,
        buckets: list(form, 'bucket'),
        industries: list(form, 'industry'),
        cities: list(form, 'city'),
        minReviews: optionalNum(form, 'minReviews') ?? undefined,
        notCalled: form.get('notCalled') === 'on',
        requirePersonalization: form.get('requirePersonalization') === 'on',
        limit: num(form, 'limit', 200),
      };
      const queue = await createCallQueue(ctx, {
        name: str(form, 'name'),
        description: optionalStr(form, 'description'),
        filters,
      });
      if (queue.totalCount === 0) {
        // Built and kept, so the operator can widen the filters rather than
        // retyping them — but said out loud instead of showing an empty screen.
        return { id: queue.id, total: 0 };
      }
      return { id: queue.id, total: queue.totalCount };
    },
    CALL_PATHS,
  );
}

export async function rebuildCallQueueAction(queueId: string) {
  return action(
    'calls.rebuildQueue',
    async () => {
      const ctx = await requireCtx('prospect:write');
      const added = await buildQueueFromFilters(ctx, queueId);
      return { added };
    },
    CALL_PATHS,
  );
}

export async function setCallQueueStatusAction(queueId: string, status: CallQueueStatus) {
  return action(
    'calls.queueStatus',
    async () => {
      const ctx = await requireCtx('prospect:write');
      await setQueueStatus(ctx, queueId, status);
      return { queueId, status };
    },
    CALL_PATHS,
  );
}

export async function addToCallQueueAction(form: FormData) {
  return action(
    'calls.addToQueue',
    async () => {
      const ctx = await requireCtx('prospect:write');
      const added = await addToQueue(ctx, str(form, 'queueId'), list(form, 'contactId'));
      return { added };
    },
    CALL_PATHS,
  );
}

export async function removeFromCallQueueAction(itemId: string) {
  return action(
    'calls.removeFromQueue',
    async () => {
      const ctx = await requireCtx('prospect:write');
      await removeFromQueue(ctx, itemId);
      return { itemId };
    },
    CALL_PATHS,
  );
}

/**
 * Starts a call.
 *
 * Returns the `tel:` URI for the browser to open. The server records that the
 * operator pressed dial and nothing more — see `initiateCall`.
 */
export async function initiateCallAction(contactId: string, queueId?: string, queueItemId?: string) {
  return action(
    'calls.initiate',
    async () => {
      const ctx = await requireCtx('message:send');
      if (queueItemId) await markItemCurrent(ctx, queueItemId);
      return initiateCall(ctx, {
        contactId,
        queueId: queueId ?? null,
        queueItemId: queueItemId ?? null,
      });
    },
    CALL_PATHS,
  );
}

export async function recordDispositionAction(form: FormData) {
  return action(
    'calls.disposition',
    async () => {
      const ctx = await requireCtx('message:send');

      const outcome = str(form, 'outcome');
      if (!(CALL_OUTCOMES as readonly string[]).includes(outcome)) {
        throw invalid('Pick an outcome for the call');
      }

      const callbackRaw = optionalStr(form, 'callbackAt');
      const callbackAt = callbackRaw ? new Date(callbackRaw) : null;
      if (callbackRaw && Number.isNaN(callbackAt?.getTime())) {
        throw invalid('That callback date and time could not be read');
      }

      return recordDisposition(ctx, {
        attemptId: optionalStr(form, 'attemptId'),
        contactId: str(form, 'contactId'),
        outcome: outcome as CallOutcome,
        note: optionalStr(form, 'note'),
        notInterestedReason: optionalStr(form, 'notInterestedReason'),
        callbackAt,
        queueItemId: optionalStr(form, 'queueItemId'),
      });
    },
    CALL_PATHS,
  );
}

export async function skipQueueItemAction(itemId: string, reason: string) {
  return action(
    'calls.skip',
    async () => {
      const ctx = await requireCtx('prospect:write');
      await skipQueueItem(ctx, itemId, reason);
      return { itemId };
    },
    CALL_PATHS,
  );
}

export async function addCallNoteAction(form: FormData) {
  return action(
    'calls.note',
    async () => {
      const ctx = await requireCtx('message:send');
      await addCallNote(ctx, str(form, 'attemptId'), str(form, 'note'));
      return { attemptId: str(form, 'attemptId') };
    },
    CALL_PATHS,
  );
}
