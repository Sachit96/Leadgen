'use client';

import { useState } from 'react';
import type { AgentType } from '@/lib/db/types';
import type { AiSettings } from '@/lib/services/settings';
import { Badge, Card, Field, cn, inputClass, selectClass } from '@/components/ui/primitives';
import { Button } from '@/components/ui/buttons';
import { ActionButton, ActionForm } from '@/components/ui/action-form';
import {
  activatePromptAction,
  createKnowledgeAction,
  createObjectionAction,
  deleteKnowledgeAction,
  deleteObjectionAction,
  savePromptAction,
  saveAiSettings,
  updateKnowledgeAction,
  updateObjectionAction,
} from '@/app/actions/settings';

type Prompt = {
  id: string;
  agentType: AgentType;
  name: string;
  version: number;
  prompt: string;
  active: boolean;
  createdAt: string;
};

type Knowledge = { id: string; category: string; title: string; content: string };
type Objection = {
  id: string;
  trigger: string;
  matchers: string[];
  strategy: string;
  exampleResponses: string[];
};

const TABS = ['behaviour', 'prompts', 'knowledge', 'objections'] as const;
type Tab = (typeof TABS)[number];

const AGENT_LABELS: Record<AgentType, string> = {
  sales: 'Sales agent',
  research: 'Research agent',
  personalization: 'Outreach writer',
  qualification: 'Qualification extractor',
  summary: 'Handoff summary',
  classifier: 'Intent classifier',
};

export function AiWorkbench({
  prompts,
  defaults,
  knowledge,
  objections,
  ai,
  canWrite,
}: {
  prompts: Prompt[];
  defaults: Record<string, string>;
  knowledge: Knowledge[];
  objections: Objection[];
  ai: AiSettings;
  canWrite: boolean;
}) {
  const [tab, setTab] = useState<Tab>('behaviour');

  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-ink-700">
        {TABS.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            aria-pressed={tab === item}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm capitalize transition-colors',
              tab === item
                ? 'border-accent-500 font-medium text-ink-100'
                : 'border-transparent text-ink-500 hover:text-ink-300',
            )}
          >
            {item}
          </button>
        ))}
      </div>

      {tab === 'behaviour' ? <BehaviourTab ai={ai} canWrite={canWrite} /> : null}
      {tab === 'prompts' ? (
        <PromptsTab prompts={prompts} defaults={defaults} canWrite={canWrite} />
      ) : null}
      {tab === 'knowledge' ? <KnowledgeTab knowledge={knowledge} canWrite={canWrite} /> : null}
      {tab === 'objections' ? <ObjectionsTab objections={objections} canWrite={canWrite} /> : null}
    </div>
  );
}

function BehaviourTab({ ai, canWrite }: { ai: AiSettings; canWrite: boolean }) {
  return (
    <Card className="max-w-2xl">
      <ActionForm action={saveAiSettings} successMessage="AI settings saved" className="space-y-4">
        <Field label="Agent name" htmlFor="agentName" hint="How the agent refers to itself.">
          <input id="agentName" name="agentName" defaultValue={ai.agentName} className={inputClass} readOnly={!canWrite} />
        </Field>

        <div className="space-y-2.5">
          <Toggle
            name="enabled"
            defaultChecked={ai.enabled}
            disabled={!canWrite}
            label="AI is enabled"
            hint="Turning this off leaves the whole app usable — conversations just need manual replies."
          />
          <Toggle
            name="autoReply"
            defaultChecked={ai.autoReply}
            disabled={!canWrite}
            label="Reply to inbound messages automatically"
            hint="With this off, the AI drafts nothing on its own; you trigger a reply per conversation."
          />
          <Toggle
            name="discloseAiWhenAsked"
            defaultChecked={ai.discloseAiWhenAsked}
            disabled={!canWrite}
            label="Disclose that it is an assistant when asked"
            hint="Either way the agent never claims to be a person — this decides whether it says so plainly or hands to a human."
          />
          <Toggle
            name="requireApprovalForFirstMessage"
            defaultChecked={ai.requireApprovalForFirstMessage}
            disabled={!canWrite}
            label="Require approval before the first message of a sequence"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Handoff confidence threshold"
            htmlFor="handoffConfidenceThreshold"
            hint="Below this, the AI escalates instead of guessing. 0–1."
          >
            <input
              id="handoffConfidenceThreshold"
              name="handoffConfidenceThreshold"
              type="number"
              step="0.05"
              min={0}
              max={1}
              defaultValue={ai.handoffConfidenceThreshold}
              className={inputClass}
              readOnly={!canWrite}
            />
          </Field>
          <Field
            label="Max AI turns per conversation"
            htmlFor="maxAiTurnsPerConversation"
            hint="After this many replies without a booking, a human takes over."
          >
            <input
              id="maxAiTurnsPerConversation"
              name="maxAiTurnsPerConversation"
              type="number"
              min={1}
              defaultValue={ai.maxAiTurnsPerConversation}
              className={inputClass}
              readOnly={!canWrite}
            />
          </Field>
        </div>

        {canWrite ? (
          <div className="flex justify-end border-t border-ink-800 pt-3">
            <Button type="submit" variant="primary">
              Save AI settings
            </Button>
          </div>
        ) : null}
      </ActionForm>
    </Card>
  );
}

function Toggle({
  name,
  label,
  hint,
  defaultChecked,
  disabled,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultChecked: boolean;
  disabled: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        disabled={disabled}
        className="mt-0.5 size-3.5 accent-blue-500"
      />
      <span>
        <span className="block text-sm text-ink-200">{label}</span>
        {hint ? <span className="block text-xs text-ink-500">{hint}</span> : null}
      </span>
    </label>
  );
}

function PromptsTab({
  prompts,
  defaults,
  canWrite,
}: {
  prompts: Prompt[];
  defaults: Record<string, string>;
  canWrite: boolean;
}) {
  const agents = Object.keys(AGENT_LABELS) as AgentType[];
  const [selected, setSelected] = useState<AgentType>('sales');

  const versions = prompts.filter((p) => p.agentType === selected).sort((a, b) => b.version - a.version);
  const active = versions.find((v) => v.active) ?? versions[0];

  return (
    <div className="grid gap-4 lg:grid-cols-4">
      <div className="lg:col-span-1">
        <ul className="space-y-1">
          {agents.map((agent) => {
            const agentVersions = prompts.filter((p) => p.agentType === agent);
            return (
              <li key={agent}>
                <button
                  type="button"
                  onClick={() => setSelected(agent)}
                  className={cn(
                    'w-full rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
                    selected === agent
                      ? 'bg-ink-800 font-medium text-ink-100'
                      : 'text-ink-400 hover:bg-ink-850 hover:text-ink-200',
                  )}
                >
                  {AGENT_LABELS[agent]}
                  <span className="ml-1.5 text-[11px] text-ink-600">
                    v{agentVersions.find((v) => v.active)?.version ?? 1}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-ink-500">
          Saving creates a new version and activates it. Every AI run records the version it used, so
          a change in results can be traced to a prompt change.
        </p>
      </div>

      <div className="lg:col-span-3">
        <Card>
          <ActionForm
            action={savePromptAction}
            successMessage="New prompt version activated"
            className="space-y-3"
          >
            <input type="hidden" name="agentType" value={selected} />
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-ink-100">{AGENT_LABELS[selected]}</h3>
              {active ? <Badge tone="accent">active: v{active.version}</Badge> : null}
            </div>

            <textarea
              key={`${selected}-${active?.id ?? 'default'}`}
              name="prompt"
              rows={20}
              required
              defaultValue={active?.prompt ?? defaults[selected] ?? ''}
              spellCheck={false}
              readOnly={!canWrite}
              className="w-full rounded-md border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs leading-relaxed text-ink-200 focus:border-accent-500 focus:outline-none"
            />

            {canWrite ? (
              <div className="flex justify-end">
                <Button type="submit" variant="primary">
                  Save as new version
                </Button>
              </div>
            ) : null}
          </ActionForm>
        </Card>

        {versions.length > 1 ? (
          <Card className="mt-3" padded={false}>
            <ul className="divide-y divide-ink-800">
              {versions.map((version) => (
                <li key={version.id} className="flex items-center gap-3 px-4 py-2">
                  <span className="text-xs text-ink-300">v{version.version}</span>
                  {version.active ? <Badge tone="positive">active</Badge> : null}
                  <span className="text-[11px] text-ink-600">
                    {new Date(version.createdAt).toLocaleString('en-CA')}
                  </span>
                  {!version.active && canWrite ? (
                    <ActionButton
                      action={() => activatePromptAction(version.id)}
                      successMessage={`Activated v${version.version}`}
                      className="ml-auto text-xs text-accent-400 hover:underline"
                    >
                      Roll back to this
                    </ActionButton>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function KnowledgeTab({ knowledge, canWrite }: { knowledge: Knowledge[]; canWrite: boolean }) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="max-w-3xl space-y-3">
      <p className="text-sm text-ink-400">
        The agent answers questions about On Radar only from this knowledge base and the offer in
        Settings. Anything it cannot answer becomes a handoff rather than a guess.
      </p>

      {canWrite ? (
        adding ? (
          <Card className="border-accent-600/40">
            <ActionForm
              action={createKnowledgeAction}
              successMessage="Knowledge added"
              onSuccess={() => setAdding(false)}
              className="space-y-2"
            >
              <div className="grid gap-2 sm:grid-cols-3">
                <select name="category" className={selectClass} defaultValue="faq">
                  {['offer', 'pricing', 'guarantee', 'faq', 'case_study', 'service', 'sales_rule'].map(
                    (category) => (
                      <option key={category} value={category}>
                        {category.replace('_', ' ')}
                      </option>
                    ),
                  )}
                </select>
                <input
                  name="title"
                  required
                  placeholder="Title"
                  className={cn(inputClass, 'sm:col-span-2')}
                />
              </div>
              <textarea name="content" required rows={3} placeholder="What the agent should know" className={inputClass} />
              <div className="flex justify-end gap-2">
                <Button size="sm" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" variant="primary">
                  Add
                </Button>
              </div>
            </ActionForm>
          </Card>
        ) : (
          <Button size="sm" onClick={() => setAdding(true)}>
            Add knowledge
          </Button>
        )
      ) : null}

      {knowledge.map((entry) => (
        <Card key={entry.id}>
          <ActionForm action={updateKnowledgeAction} successMessage="Saved" className="space-y-2">
            <input type="hidden" name="id" value={entry.id} />
            <div className="flex items-center gap-2">
              <select
                name="category"
                defaultValue={entry.category}
                className={cn(selectClass, 'w-auto')}
                disabled={!canWrite}
              >
                {['offer', 'pricing', 'guarantee', 'faq', 'case_study', 'service', 'sales_rule'].map(
                  (category) => (
                    <option key={category} value={category}>
                      {category.replace('_', ' ')}
                    </option>
                  ),
                )}
              </select>
              <input name="title" defaultValue={entry.title} className={inputClass} readOnly={!canWrite} />
            </div>
            <textarea name="content" rows={2} defaultValue={entry.content} className={inputClass} readOnly={!canWrite} />
            {canWrite ? (
              <div className="flex justify-end gap-2">
                <ActionButton
                  action={() => deleteKnowledgeAction(entry.id)}
                  confirm={`Delete "${entry.title}"?`}
                  successMessage="Deleted"
                  className="rounded px-2 py-1 text-xs text-danger-400 hover:bg-danger-500/10"
                >
                  Delete
                </ActionButton>
                <Button type="submit" size="sm">
                  Save
                </Button>
              </div>
            ) : null}
          </ActionForm>
        </Card>
      ))}
    </div>
  );
}

function ObjectionsTab({ objections, canWrite }: { objections: Objection[]; canWrite: boolean }) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="max-w-3xl space-y-3">
      <p className="text-sm text-ink-400">
        Strategies, not scripts. The agent is told how to handle each objection and given examples,
        but it never repeats the same wording twice in a conversation.
      </p>

      {canWrite ? (
        adding ? (
          <Card className="border-accent-600/40">
            <ActionForm
              action={createObjectionAction}
              successMessage="Objection added"
              onSuccess={() => setAdding(false)}
              className="space-y-2"
            >
              <input name="trigger" required placeholder='Objection, e.g. "Too expensive."' className={inputClass} />
              <input name="matchers" placeholder="Comma-separated phrases to match" className={inputClass} />
              <textarea name="strategy" required rows={2} placeholder="How to handle it" className={inputClass} />
              <textarea name="exampleResponses" rows={2} placeholder="Example responses, one per line" className={inputClass} />
              <div className="flex justify-end gap-2">
                <Button size="sm" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" variant="primary">
                  Add
                </Button>
              </div>
            </ActionForm>
          </Card>
        ) : (
          <Button size="sm" onClick={() => setAdding(true)}>
            Add objection
          </Button>
        )
      ) : null}

      {objections.map((objection) => (
        <Card key={objection.id}>
          <ActionForm action={updateObjectionAction} successMessage="Saved" className="space-y-2">
            <input type="hidden" name="id" value={objection.id} />
            <input name="trigger" defaultValue={objection.trigger} className={inputClass} readOnly={!canWrite} />
            <input
              name="matchers"
              defaultValue={objection.matchers.join(', ')}
              placeholder="Comma-separated phrases"
              className={inputClass}
              readOnly={!canWrite}
            />
            <textarea name="strategy" rows={2} defaultValue={objection.strategy} className={inputClass} readOnly={!canWrite} />
            <textarea
              name="exampleResponses"
              rows={2}
              defaultValue={objection.exampleResponses.join('\n')}
              className={inputClass}
              readOnly={!canWrite}
            />
            {canWrite ? (
              <div className="flex justify-end gap-2">
                <ActionButton
                  action={() => deleteObjectionAction(objection.id)}
                  confirm={`Delete "${objection.trigger}"?`}
                  successMessage="Deleted"
                  className="rounded px-2 py-1 text-xs text-danger-400 hover:bg-danger-500/10"
                >
                  Delete
                </ActionButton>
                <Button type="submit" size="sm">
                  Save
                </Button>
              </div>
            ) : null}
          </ActionForm>
        </Card>
      ))}
    </div>
  );
}
