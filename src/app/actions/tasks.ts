'use server';

import { requireCtx } from '@/lib/auth/context';
import { cancelTask, completeTask, createTask } from '@/lib/services/tasks';
import { action, optionalStr, str } from './helpers';

export async function completeTaskAction(id: string) {
  return action('task.complete', async () => {
    const ctx = await requireCtx('prospect:write');
    await completeTask(ctx, id);
  }, ['/', '/prospects', '/inbox']);
}

export async function cancelTaskAction(id: string) {
  return action('task.cancel', async () => {
    const ctx = await requireCtx('prospect:write');
    await cancelTask(ctx, id);
  }, ['/']);
}

export async function createTaskAction(form: FormData) {
  return action('task.create', async () => {
    const ctx = await requireCtx('prospect:write');
    const dueAt = optionalStr(form, 'dueAt');
    await createTask(ctx, {
      title: str(form, 'title'),
      kind: str(form, 'kind') || 'follow_up',
      notes: optionalStr(form, 'notes'),
      contactId: optionalStr(form, 'contactId'),
      conversationId: optionalStr(form, 'conversationId'),
      dueAt: dueAt ? new Date(dueAt) : null,
    });
  }, ['/', '/inbox', '/prospects']);
}
