'use client';

import { useState } from 'react';
import type { CampaignSequence } from '@/lib/services/campaigns';
import { AVAILABLE_VARIABLES, MESSAGE_ANGLES } from '@/lib/constants/enums';
import { segmentInfo, extractVariables } from '@/lib/core/template';
import { Badge, Card, Field, SectionTitle, cn, inputClass, selectClass } from '@/components/ui/primitives';
import { Button } from '@/components/ui/buttons';
import { ActionButton, ActionForm } from '@/components/ui/action-form';
import {
  createStepAction,
  createVariantAction,
  deleteStepAction,
  deleteVariantAction,
  updateStepAction,
  updateVariantAction,
} from '@/app/actions/campaigns';

const CONDITIONS = [
  { value: 'no_response', label: 'Only if they have not replied' },
  { value: 'replied', label: 'Only if they replied' },
  { value: 'positive', label: 'Only if the reply was positive' },
  { value: 'not_booked', label: 'Only if no appointment yet' },
];

const STOP_CONDITIONS = [
  { value: 'replied', label: 'They reply' },
  { value: 'positive', label: 'They reply positively' },
  { value: 'negative', label: 'They decline' },
  { value: 'booked', label: 'An appointment is booked' },
  { value: 'human_takeover', label: 'A human takes over' },
  { value: 'failed_delivery', label: 'Messages stop being delivered' },
];

/**
 * The sequence as a vertical flow: each step shows when it fires, what stops
 * it, and the message variants competing inside it. The point is that a
 * non-technical operator can read the campaign top to bottom and understand
 * exactly what a prospect will receive.
 */
export function SequenceBuilder({
  campaignId,
  steps,
  canWrite,
}: {
  campaignId: string;
  steps: CampaignSequence;
  canWrite: boolean;
}) {
  const [addingStep, setAddingStep] = useState(false);

  return (
    <section>
      <SectionTitle
        action={
          canWrite ? (
            <Button size="sm" onClick={() => setAddingStep((v) => !v)}>
              {addingStep ? 'Cancel' : 'Add step'}
            </Button>
          ) : null
        }
      >
        Sequence
      </SectionTitle>

      {steps.length === 0 && !addingStep ? (
        <Card>
          <p className="text-sm text-ink-500">
            This campaign has no steps yet. A campaign cannot be activated until it has at least one
            step with an active message variant.
          </p>
        </Card>
      ) : null}

      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs text-ink-500">
          <span className="rounded border border-ink-700 bg-ink-850 px-2 py-1">Prospect enrolled</span>
          <span aria-hidden="true">→</span>
        </div>

        {steps.map((step, index) => (
          <StepCard
            key={step.id}
            campaignId={campaignId}
            step={step}
            index={index}
            canWrite={canWrite}
          />
        ))}

        {addingStep ? (
          <Card className="border-accent-600/40">
            <ActionForm
              action={createStepAction}
              successMessage="Step added"
              onSuccess={() => setAddingStep(false)}
              className="space-y-3"
            >
              <input type="hidden" name="campaignId" value={campaignId} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Step name" htmlFor="new-step-name">
                  <input
                    id="new-step-name"
                    name="name"
                    required
                    autoFocus
                    placeholder="Follow-up"
                    className={inputClass}
                  />
                </Field>
                <Field
                  label="Wait before sending (hours)"
                  htmlFor="new-step-delay"
                  hint="Measured from the previous step."
                >
                  <input
                    id="new-step-delay"
                    name="delayHours"
                    type="number"
                    min={0}
                    defaultValue={steps.length === 0 ? 0 : 72}
                    className={inputClass}
                  />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm text-ink-300">
                <input type="checkbox" name="useAi" className="size-3.5 accent-blue-500" />
                Let the AI write this message per prospect instead of using variants
              </label>
              <div className="flex justify-end">
                <Button type="submit" variant="primary" size="sm">
                  Add step
                </Button>
              </div>
            </ActionForm>
          </Card>
        ) : null}

        <div className="flex items-center gap-2 text-xs text-ink-500">
          <span aria-hidden="true">→</span>
          <span className="rounded border border-ink-700 bg-ink-850 px-2 py-1">
            Reply → AI conversation → qualification → booking → CRM
          </span>
        </div>
      </div>
    </section>
  );
}

function StepCard({
  campaignId,
  step,
  index,
  canWrite,
}: {
  campaignId: string;
  step: CampaignSequence[number];
  index: number;
  canWrite: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [addingVariant, setAddingVariant] = useState(false);

  const conditions = Array.isArray(step.conditions) ? (step.conditions as string[]) : [];
  const stopConditions = Array.isArray(step.stopConditions) ? (step.stopConditions as string[]) : [];

  return (
    <Card className={cn(!step.active && 'opacity-60')} padded={false}>
      <div className="flex items-start justify-between gap-3 border-b border-ink-800 p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex size-5 shrink-0 items-center justify-center rounded bg-ink-750 text-[11px] font-semibold text-ink-300">
              {index + 1}
            </span>
            <h3 className="text-sm font-medium text-ink-100">{step.name}</h3>
            {step.useAi ? <Badge tone="accent">AI writes this</Badge> : null}
            {!step.active ? <Badge tone="neutral">inactive</Badge> : null}
          </div>
          <p className="mt-1 text-xs text-ink-500">
            {step.delayHours === 0
              ? 'Sends immediately on enrollment'
              : `Waits ${formatDelay(step.delayHours)} after the previous step`}
            {conditions.length > 0
              ? ` · ${conditions.map((c) => CONDITIONS.find((x) => x.value === c)?.label ?? c).join(', ')}`
              : ''}
          </p>
          {stopConditions.length > 0 ? (
            <p className="mt-0.5 text-xs text-ink-600">
              Stops the sequence when:{' '}
              {stopConditions
                .map((c) => STOP_CONDITIONS.find((x) => x.value === c)?.label ?? c)
                .join(', ')}
            </p>
          ) : null}
        </div>

        {canWrite ? (
          <div className="flex shrink-0 gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>
              {editing ? 'Close' : 'Edit'}
            </Button>
            <ActionButton
              action={() => deleteStepAction(step.id)}
              confirm={`Delete step "${step.name}" and its variants?`}
              successMessage="Step deleted"
              className="rounded px-2 text-xs text-danger-400 hover:bg-danger-500/10"
            >
              Delete
            </ActionButton>
          </div>
        ) : null}
      </div>

      {editing ? (
        <div className="border-b border-ink-800 bg-ink-900 p-4">
          <ActionForm
            action={updateStepAction}
            successMessage="Step updated"
            onSuccess={() => setEditing(false)}
            className="space-y-3"
          >
            <input type="hidden" name="stepId" value={step.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Step name" htmlFor={`name-${step.id}`}>
                <input id={`name-${step.id}`} name="name" defaultValue={step.name} className={inputClass} />
              </Field>
              <Field label="Wait (hours)" htmlFor={`delay-${step.id}`}>
                <input
                  id={`delay-${step.id}`}
                  name="delayHours"
                  type="number"
                  min={0}
                  defaultValue={step.delayHours}
                  className={inputClass}
                />
              </Field>
            </div>

            <fieldset>
              <legend className="mb-1 text-xs font-medium text-ink-300">Only send if</legend>
              <div className="flex flex-wrap gap-1.5">
                {CONDITIONS.map((condition) => (
                  <label
                    key={condition.value}
                    className="flex cursor-pointer items-center gap-1.5 rounded border border-ink-600 px-2 py-1 text-xs text-ink-300 has-[:checked]:border-accent-500 has-[:checked]:bg-accent-600/20 has-[:checked]:text-accent-400"
                  >
                    <input
                      type="checkbox"
                      name="conditions"
                      value={condition.value}
                      defaultChecked={conditions.includes(condition.value)}
                      className="sr-only"
                    />
                    {condition.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className="mb-1 text-xs font-medium text-ink-300">Stop the sequence when</legend>
              <div className="flex flex-wrap gap-1.5">
                {STOP_CONDITIONS.map((condition) => (
                  <label
                    key={condition.value}
                    className="flex cursor-pointer items-center gap-1.5 rounded border border-ink-600 px-2 py-1 text-xs text-ink-300 has-[:checked]:border-warning-500 has-[:checked]:bg-warning-500/20 has-[:checked]:text-warning-400"
                  >
                    <input
                      type="checkbox"
                      name="stopConditions"
                      value={condition.value}
                      defaultChecked={stopConditions.includes(condition.value)}
                      className="sr-only"
                    />
                    {condition.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-ink-300">
                <input
                  type="checkbox"
                  name="useAi"
                  defaultChecked={step.useAi}
                  className="size-3.5 accent-blue-500"
                />
                AI writes this message
              </label>
              <label className="flex items-center gap-2 text-sm text-ink-300">
                <input
                  type="checkbox"
                  name="active"
                  defaultChecked={step.active}
                  className="size-3.5 accent-blue-500"
                />
                Step is active
              </label>
            </div>

            <div className="flex justify-end">
              <Button type="submit" variant="primary" size="sm">
                Save step
              </Button>
            </div>
          </ActionForm>
        </div>
      ) : null}

      <div className="p-4">
        {step.useAi ? (
          <p className="text-xs text-ink-500">
            The AI writes this message for each prospect from their verified research. If it cannot
            produce one, that prospect is paused rather than sent a generic message.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              {step.variants.length === 0 ? (
                <p className="text-xs text-warning-400">
                  No variants yet — this step cannot send until one is added.
                </p>
              ) : (
                step.variants.map((variant) => (
                  <VariantRow
                    key={variant.id}
                    campaignId={campaignId}
                    stepId={step.id}
                    variant={variant}
                    canWrite={canWrite}
                  />
                ))
              )}
            </div>

            {canWrite ? (
              <div className="mt-3">
                {addingVariant ? (
                  <ActionForm
                    action={createVariantAction}
                    successMessage="Variant added"
                    onSuccess={() => setAddingVariant(false)}
                    className="space-y-2 rounded-md border border-accent-600/40 bg-ink-900 p-3"
                  >
                    <input type="hidden" name="campaignId" value={campaignId} />
                    <input type="hidden" name="stepId" value={step.id} />
                    <div className="grid gap-2 sm:grid-cols-3">
                      <input name="name" required placeholder="Variant name" className={inputClass} />
                      <select name="angle" className={selectClass} defaultValue="curiosity">
                        {MESSAGE_ANGLES.map((angle) => (
                          <option key={angle.key} value={angle.key}>
                            {angle.label}
                          </option>
                        ))}
                      </select>
                      <input
                        name="weight"
                        type="number"
                        min={1}
                        defaultValue={1}
                        aria-label="Weight"
                        className={inputClass}
                      />
                    </div>
                    <TemplateEditor name="template" />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" onClick={() => setAddingVariant(false)}>
                        Cancel
                      </Button>
                      <Button type="submit" size="sm" variant="primary">
                        Add variant
                      </Button>
                    </div>
                  </ActionForm>
                ) : (
                  <Button size="sm" onClick={() => setAddingVariant(true)}>
                    Add message variant
                  </Button>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}

function VariantRow({
  campaignId,
  stepId,
  variant,
  canWrite,
}: {
  campaignId: string;
  stepId: string;
  variant: CampaignSequence[number]['variants'][number];
  canWrite: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const info = segmentInfo(variant.template);

  if (editing) {
    return (
      <ActionForm
        action={updateVariantAction}
        successMessage="Variant saved"
        onSuccess={() => setEditing(false)}
        className="space-y-2 rounded-md border border-accent-600/40 bg-ink-900 p-3"
      >
        <input type="hidden" name="variantId" value={variant.id} />
        <input type="hidden" name="campaignId" value={campaignId} />
        <input type="hidden" name="stepId" value={stepId} />
        <div className="grid gap-2 sm:grid-cols-3">
          <input name="name" defaultValue={variant.name} className={inputClass} />
          <select name="angle" defaultValue={variant.angle} className={selectClass}>
            {MESSAGE_ANGLES.map((angle) => (
              <option key={angle.key} value={angle.key}>
                {angle.label}
              </option>
            ))}
          </select>
          <input
            name="weight"
            type="number"
            min={1}
            defaultValue={variant.weight}
            aria-label="Weight"
            className={inputClass}
          />
        </div>
        <TemplateEditor name="template" defaultValue={variant.template} />
        <label className="flex items-center gap-2 text-xs text-ink-300">
          <input
            type="checkbox"
            name="active"
            defaultChecked={variant.active}
            className="size-3.5 accent-blue-500"
          />
          Active
        </label>
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button type="submit" size="sm" variant="primary">
            Save
          </Button>
        </div>
      </ActionForm>
    );
  }

  return (
    <div
      className={cn(
        'rounded-md border border-ink-700 bg-ink-900 p-3',
        !variant.active && 'opacity-50',
      )}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-ink-200">{variant.name}</span>
        <Badge tone="neutral">{variant.angle.replace(/_/g, ' ')}</Badge>
        <span className="text-[11px] text-ink-500">weight {variant.weight}</span>
        {!variant.active ? <Badge tone="neutral">off</Badge> : null}
        {canWrite ? (
          <div className="ml-auto flex gap-1.5">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-xs text-ink-400 hover:text-ink-100"
            >
              Edit
            </button>
            <ActionButton
              action={() => deleteVariantAction(variant.id)}
              confirm={`Delete variant "${variant.name}"?`}
              successMessage="Variant deleted"
              className="text-xs text-danger-400 hover:text-danger-500"
            >
              Delete
            </ActionButton>
          </div>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap text-sm text-ink-300">{variant.template}</p>
      <p className="mt-1.5 text-[11px] text-ink-600">
        {info.characters} chars · {info.segments} segment{info.segments === 1 ? '' : 's'}
      </p>
    </div>
  );
}

/** Template textarea with live variable and segment feedback. */
function TemplateEditor({ name, defaultValue = '' }: { name: string; defaultValue?: string }) {
  const [value, setValue] = useState(defaultValue);
  const info = segmentInfo(value);
  const used = extractVariables(value);
  const known = new Set<string>(AVAILABLE_VARIABLES.map((v) => v.key));
  const unknown = used.filter((v) => !known.has(v));

  return (
    <div>
      <textarea
        name={name}
        required
        rows={3}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Hi {{first_name}}, question about {{company}} — what happens to the estimates that never close?"
        className={inputClass}
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className="tabular-nums text-ink-500">
          {info.characters} chars · {info.segments} segment{info.segments === 1 ? '' : 's'} ·{' '}
          {info.encoding}
        </span>
        {unknown.length > 0 ? (
          <span className="text-danger-400">
            Unknown variable{unknown.length > 1 ? 's' : ''}: {unknown.join(', ')}
          </span>
        ) : null}
      </div>
      <details className="mt-1.5">
        <summary className="cursor-pointer text-[11px] text-ink-500 hover:text-ink-300">
          Available variables
        </summary>
        <ul className="mt-1 space-y-0.5">
          {AVAILABLE_VARIABLES.map((variable) => (
            <li key={variable.key} className="text-[11px] text-ink-500">
              <button
                type="button"
                onClick={() => setValue((current) => `${current}{{${variable.key}}}`)}
                className="font-mono text-accent-400 hover:underline"
              >
                {`{{${variable.key}}}`}
              </button>{' '}
              — {variable.description}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function formatDelay(hours: number): string {
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
