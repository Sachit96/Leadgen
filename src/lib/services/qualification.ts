import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { qualifications } from '@/lib/db/schema';
import { recordActivity } from './activity';
import type { Ctx } from '@/lib/auth/context';
import type { Qualification } from '@/lib/db/types';

/**
 * Qualification fields are configuration, not code. The defaults target
 * contractor lead-follow-up, which is the initial On Radar use case, but a new
 * niche is a different field list rather than a different codebase.
 */
export type QualificationField = {
  key: string;
  label: string;
  /** What the AI should try to learn, phrased as the underlying question. */
  question: string;
  type: 'number' | 'text' | 'boolean' | 'money';
  required: boolean;
  /** Lower numbers are asked earlier. */
  order: number;
};

export const DEFAULT_QUALIFICATION_FIELDS: QualificationField[] = [
  {
    key: 'monthly_lead_volume',
    label: 'Monthly lead volume',
    question: 'Roughly how many leads or estimate requests come in each month?',
    type: 'number',
    required: true,
    order: 1,
  },
  {
    key: 'average_job_value',
    label: 'Average job value',
    question: 'What does a typical job come out to?',
    type: 'money',
    required: true,
    order: 2,
  },
  {
    key: 'current_follow_up_process',
    label: 'Current follow-up process',
    question: 'How do you follow up on estimates that have not closed?',
    type: 'text',
    required: true,
    order: 3,
  },
  {
    key: 'follow_up_duration',
    label: 'How long they follow up',
    question: 'How long do you keep following up before you let one go?',
    type: 'text',
    required: false,
    order: 4,
  },
  {
    key: 'speed_to_lead',
    label: 'Speed to lead',
    question: 'How quickly does someone usually get back to a new lead?',
    type: 'text',
    required: false,
    order: 5,
  },
  {
    key: 'team_size',
    label: 'Team size',
    question: 'How many people are on the team or in the field?',
    type: 'number',
    required: false,
    order: 6,
  },
  {
    key: 'service_area',
    label: 'Service area',
    question: 'What area do you cover?',
    type: 'text',
    required: false,
    order: 7,
  },
  {
    key: 'current_crm',
    label: 'Current CRM',
    question: 'Are you using a CRM or is it mostly a phone and a notebook?',
    type: 'text',
    required: false,
    order: 8,
  },
  {
    key: 'appointment_process',
    label: 'Appointment process',
    question: 'How do estimates get booked in right now?',
    type: 'text',
    required: false,
    order: 9,
  },
  {
    key: 'biggest_sales_bottleneck',
    label: 'Biggest bottleneck',
    question: 'What is the biggest thing slowing the sales side down?',
    type: 'text',
    required: true,
    order: 10,
  },
];

export type QualificationValue = {
  value: string | number | boolean;
  source: 'ai' | 'human';
  confidence: number;
  capturedAt: string;
};

export type QualificationFields = Record<string, QualificationValue>;

export function parseFields(raw: unknown): QualificationFields {
  if (!raw || typeof raw !== 'object') return {};
  const out: QualificationFields = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const inner = record.value;
    if (inner === null || inner === undefined) continue;
    if (typeof inner !== 'string' && typeof inner !== 'number' && typeof inner !== 'boolean') continue;
    out[key] = {
      value: inner,
      source: record.source === 'human' ? 'human' : 'ai',
      confidence: typeof record.confidence === 'number' ? record.confidence : 0.5,
      capturedAt: typeof record.capturedAt === 'string' ? record.capturedAt : new Date().toISOString(),
    };
  }
  return out;
}

export function completenessOf(
  fields: QualificationFields,
  definitions: QualificationField[] = DEFAULT_QUALIFICATION_FIELDS,
): number {
  const required = definitions.filter((f) => f.required);
  if (required.length === 0) return 0;
  const answered = required.filter((f) => fields[f.key] !== undefined).length;
  return Math.round((answered / required.length) * 100) / 100;
}

/** The next field to pursue: required first, then by configured order. */
export function nextQuestion(
  fields: QualificationFields,
  definitions: QualificationField[] = DEFAULT_QUALIFICATION_FIELDS,
): QualificationField | null {
  const missing = definitions
    .filter((f) => fields[f.key] === undefined)
    .sort((a, b) => Number(b.required) - Number(a.required) || a.order - b.order);
  return missing[0] ?? null;
}

export async function getQualification(
  ctx: Ctx,
  conversationId: string,
): Promise<Qualification | null> {
  const rows = await getDb()
    .select()
    .from(qualifications)
    .where(
      and(
        eq(qualifications.organizationId, ctx.organizationId),
        eq(qualifications.conversationId, conversationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export type ApplyQualificationInput = {
  conversationId: string;
  contactId: string;
  updates: Record<string, string | number | boolean>;
  source: 'ai' | 'human';
  confidence?: number;
};

/**
 * Merges newly learned fields. A human-sourced answer is never overwritten by
 * the AI — the operator is the authority on their own CRM.
 */
export async function applyQualification(
  ctx: Ctx,
  input: ApplyQualificationInput,
): Promise<{ fields: QualificationFields; completeness: number; changed: string[] }> {
  const db = getDb();
  const existing = await getQualification(ctx, input.conversationId);
  const fields = parseFields(existing?.fields);
  const changed: string[] = [];

  for (const [key, value] of Object.entries(input.updates)) {
    if (value === null || value === undefined || value === '') continue;
    const current = fields[key];
    if (current && current.source === 'human' && input.source === 'ai') continue;
    if (current && current.value === value) continue;
    fields[key] = {
      value,
      source: input.source,
      confidence: input.confidence ?? (input.source === 'human' ? 1 : 0.7),
      capturedAt: new Date().toISOString(),
    };
    changed.push(key);
  }

  const completeness = completenessOf(fields);

  if (existing) {
    await db
      .update(qualifications)
      .set({
        fields,
        completeness,
        qualifiedAt: completeness >= 1 ? (existing.qualifiedAt ?? new Date()) : existing.qualifiedAt,
        updatedAt: new Date(),
      })
      .where(eq(qualifications.id, existing.id));
  } else {
    await db.insert(qualifications).values({
      organizationId: ctx.organizationId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      fields,
      completeness,
      qualifiedAt: completeness >= 1 ? new Date() : null,
    });
  }

  if (changed.length > 0) {
    await recordActivity(ctx, {
      type: 'qualification_updated',
      title: `Qualification updated: ${changed.join(', ')}`,
      contactId: input.contactId,
      conversationId: input.conversationId,
      metadata: { changed, source: input.source },
    });
  }

  return { fields, completeness, changed };
}

export function describeQualification(fields: QualificationFields): string {
  const entries = Object.entries(fields);
  if (entries.length === 0) return 'Nothing captured yet.';
  return entries
    .map(([key, value]) => {
      const label = DEFAULT_QUALIFICATION_FIELDS.find((f) => f.key === key)?.label ?? key;
      return `${label}: ${value.value}`;
    })
    .join('\n');
}
