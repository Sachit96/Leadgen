'use client';

import { useState } from 'react';
import { ActionButton, ActionForm } from '@/components/ui/action-form';
import { Button } from '@/components/ui/buttons';
import { Badge, inputClass, selectClass } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button-styles';
import { addToCallQueueAction } from '@/app/actions/calls';
import { bulkAssignCampaign } from '@/app/actions/prospects';
import {
  approveLeadsAction,
  regenerateLeadCopyAction,
  rejectLeadsAction,
  requeueLeadAction,
  type RequeueStage,
} from '@/app/actions/lead-generation';

const STAGES: Array<{ stage: RequeueStage; label: string }> = [
  { stage: 'website_enrichment', label: 'Re-crawl site' },
  { stage: 'ai_research', label: 'Re-research' },
  { stage: 'lead_scoring', label: 'Re-score' },
  { stage: 'personalization_generation', label: 'Rewrite opener' },
];

/**
 * Approve, reject, or send the lead back through a stage.
 *
 * Rejection asks for a reason because the reason is the only thing that makes
 * a rejected lead useful later — the record itself is never deleted.
 */
export function LeadReviewActions({
  contactId,
  companyId,
  stage,
  callReadiness,
  queues,
  campaigns,
  canWrite,
}: {
  contactId: string;
  companyId: string | null;
  stage: string | null;
  callReadiness: string;
  queues: Array<{ id: string; name: string }>;
  campaigns: Array<{ id: string; name: string }>;
  canWrite: boolean;
}) {
  const [rejecting, setRejecting] = useState(false);
  const callable = callReadiness === 'READY' || callReadiness === 'QUEUED';

  if (!canWrite) {
    return <p className="text-sm text-ink-400">Your role can view leads but not change them.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-500">
          Stage <Badge>{(stage ?? 'unknown').toLowerCase()}</Badge>
        </span>

        <ActionForm action={approveLeadsAction} successMessage="Approved" className="contents">
          <input type="hidden" name="contactId" value={contactId} />
          <Button type="submit" variant="primary" size="sm">
            Approve
          </Button>
        </ActionForm>

        <Button variant="danger" size="sm" onClick={() => setRejecting((r) => !r)}>
          Reject
        </Button>

        {companyId ? (
          <ActionButton
            action={() => regenerateLeadCopyAction(contactId, companyId)}
            successMessage="Research and opening line regenerated"
            className={buttonClass('secondary', 'sm')}
          >
            Regenerate copy
          </ActionButton>
        ) : null}
      </div>

      {rejecting ? (
        <ActionForm
          action={rejectLeadsAction}
          successMessage="Rejected — the record stays in the CRM"
          onSuccess={() => setRejecting(false)}
          className="flex items-center gap-2"
        >
          <input type="hidden" name="contactId" value={contactId} />
          <input
            name="reason"
            autoFocus
            placeholder="Why is this not a fit?"
            className={`${inputClass} flex-1`}
          />
          <Button type="submit" variant="danger" size="sm">
            Confirm reject
          </Button>
        </ActionForm>
      ) : null}

      <div className="flex flex-wrap gap-1.5 border-t border-ink-800 pt-3">
        {STAGES.map((item) => (
          <ActionButton
            key={item.stage}
            action={() => requeueLeadAction(contactId, item.stage)}
            successMessage={`${item.label} queued — the worker picks it up next tick`}
            className={buttonClass('ghost', 'sm')}
          >
            {item.label}
          </ActionButton>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-ink-800 pt-3">
        {campaigns.length > 0 ? (
          <ActionForm
            action={bulkAssignCampaign}
            successMessage="Enrolled — the sequence sends on its own schedule, nothing goes out now"
            className="flex items-center gap-2"
          >
            <input type="hidden" name="ids" value={contactId} />
            <select name="campaignId" className={`${selectClass} h-7 w-44 py-0 text-xs`}>
              {campaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </option>
              ))}
            </select>
            <Button type="submit" variant="secondary" size="sm">
              Add to campaign
            </Button>
          </ActionForm>
        ) : null}

        {queues.length > 0 ? (
          <ActionForm
            action={addToCallQueueAction}
            successMessage="Added to the call queue"
            className="flex items-center gap-2"
          >
            <input type="hidden" name="contactId" value={contactId} />
            <select name="queueId" className={`${selectClass} h-7 w-44 py-0 text-xs`}>
              {queues.map((queue) => (
                <option key={queue.id} value={queue.id}>
                  {queue.name}
                </option>
              ))}
            </select>
            <Button type="submit" variant="secondary" size="sm" disabled={!callable}>
              Add to call queue
            </Button>
          </ActionForm>
        ) : null}
      </div>

      {!callable ? (
        <p className="text-xs text-ink-500">
          Not call-ready yet, so it cannot be queued for a call. A lead needs a validated phone
          number, a company with an industry and a location, a score, and a score at or above the
          minimum its run was started with.
        </p>
      ) : null}
    </div>
  );
}
