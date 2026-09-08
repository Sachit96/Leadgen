import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { companies, contacts, tasks } from '@/lib/db/schema';
import { notFound } from '@/lib/core/errors';
import { assertCan } from '@/lib/auth/rbac';
import type { Ctx } from '@/lib/auth/context';
import type { Task } from '@/lib/db/types';

export const TASK_KINDS = [
  { key: 'call', label: 'Call prospect' },
  { key: 'reply', label: 'Reply to prospect' },
  { key: 'follow_up', label: 'Follow up' },
  { key: 'review_ai', label: 'Review AI conversation' },
  { key: 'prep_appointment', label: 'Prepare for appointment' },
  { key: 'send_proposal', label: 'Send proposal' },
] as const;

export type TaskInput = {
  title: string;
  kind?: string;
  notes?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
  dealId?: string | null;
  dueAt?: Date | null;
  priority?: number;
  assignedUserId?: string | null;
};

export async function createTask(ctx: Ctx, input: TaskInput): Promise<Task> {
  assertCan(ctx.role, 'prospect:write');
  const [row] = await getDb()
    .insert(tasks)
    .values({
      organizationId: ctx.organizationId,
      title: input.title.trim(),
      kind: input.kind ?? 'follow_up',
      notes: input.notes ?? null,
      contactId: input.contactId ?? null,
      conversationId: input.conversationId ?? null,
      dealId: input.dealId ?? null,
      dueAt: input.dueAt ?? null,
      priority: input.priority ?? 2,
      assignedUserId: input.assignedUserId ?? ctx.user?.userId ?? null,
    })
    .returning();
  return row!;
}

export async function completeTask(ctx: Ctx, id: string): Promise<void> {
  assertCan(ctx.role, 'prospect:write');
  const updated = await getDb()
    .update(tasks)
    .set({ status: 'DONE', completedAt: new Date() })
    .where(and(eq(tasks.id, id), eq(tasks.organizationId, ctx.organizationId)))
    .returning({ id: tasks.id });
  if (updated.length === 0) throw notFound('Task');
}

export async function cancelTask(ctx: Ctx, id: string): Promise<void> {
  assertCan(ctx.role, 'prospect:write');
  await getDb()
    .update(tasks)
    .set({ status: 'CANCELLED', completedAt: new Date() })
    .where(and(eq(tasks.id, id), eq(tasks.organizationId, ctx.organizationId)));
}

export type TaskRow = {
  task: Task;
  contactName: string | null;
  companyName: string | null;
  phone: string | null;
};

export async function listOpenTasks(
  ctx: Ctx,
  options: { dueBefore?: Date; assignedTo?: string; limit?: number } = {},
): Promise<TaskRow[]> {
  const clauses = [eq(tasks.organizationId, ctx.organizationId), eq(tasks.status, 'OPEN')];
  if (options.dueBefore) {
    const dueClause = or(lte(tasks.dueAt, options.dueBefore), isNull(tasks.dueAt));
    if (dueClause) clauses.push(dueClause);
  }
  if (options.assignedTo) clauses.push(eq(tasks.assignedUserId, options.assignedTo));

  const rows = await getDb()
    .select({
      task: tasks,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      phone: contacts.phone,
      companyName: companies.name,
    })
    .from(tasks)
    .leftJoin(contacts, eq(contacts.id, tasks.contactId))
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(...clauses))
    .orderBy(asc(tasks.priority), sql`${tasks.dueAt} asc nulls last`)
    .limit(options.limit ?? 50);

  return rows.map((r) => ({
    task: r.task,
    contactName: [r.firstName, r.lastName].filter(Boolean).join(' ') || null,
    companyName: r.companyName,
    phone: r.phone,
  }));
}

export async function countOpenTasks(ctx: Ctx): Promise<number> {
  const rows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.organizationId, ctx.organizationId), eq(tasks.status, 'OPEN')));
  return rows[0]?.count ?? 0;
}
