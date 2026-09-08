'use client';

import Link from 'next/link';
import { useTransition } from 'react';
import type { TaskRow as TaskRowType } from '@/lib/services/tasks';
import { completeTaskAction } from '@/app/actions/tasks';
import { useToast } from '@/components/ui/toast';
import { formatRelative } from '@/lib/core/time';

export function TaskRow({ row }: { row: TaskRowType }) {
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  const overdue = row.task.dueAt ? row.task.dueAt.getTime() < Date.now() : false;

  return (
    <li className="flex items-start gap-2.5 p-3">
      <button
        type="button"
        aria-label={`Mark "${row.task.title}" done`}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await completeTaskAction(row.task.id);
            toast.push(result.ok ? 'Task completed' : result.error, result.ok ? 'success' : 'error');
          })
        }
        className="mt-0.5 size-4 shrink-0 rounded border border-ink-600 transition-colors hover:border-accent-500 hover:bg-accent-500/20 disabled:opacity-50"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink-200">{row.task.title}</p>
        <p className="mt-0.5 truncate text-xs text-ink-500">
          {row.companyName ?? row.contactName ?? '—'}
          {row.task.dueAt ? (
            <span className={overdue ? 'ml-1.5 text-danger-400' : 'ml-1.5'}>
              · {formatRelative(row.task.dueAt)}
            </span>
          ) : null}
        </p>
      </div>
      {row.task.conversationId ? (
        <Link
          href={`/inbox/${row.task.conversationId}`}
          className="shrink-0 text-xs text-accent-400 hover:underline"
        >
          Open
        </Link>
      ) : null}
    </li>
  );
}
