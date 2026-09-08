import { requireCtx } from '@/lib/auth/context';
import { listPipeline } from '@/lib/services/pipeline';
import { getOrgConfig } from '@/lib/services/settings';
import { PageHeader } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/buttons';
import { PipelineBoard } from './board';

export const dynamic = 'force-dynamic';

export default async function PipelinePage() {
  const ctx = await requireCtx('pipeline:read');
  const [deals, config] = await Promise.all([listPipeline(ctx), getOrgConfig(ctx)]);

  return (
    <div className="flex h-screen flex-col p-6">
      <PageHeader
        title="Pipeline"
        subtitle="Drag a card to move the deal. Every move is recorded on the prospect's timeline."
        actions={
          <a href="/api/export?kind=pipeline" className={buttonClass('secondary')}>
            Export CSV
          </a>
        }
      />
      <PipelineBoard
        deals={deals}
        currency={config.offer.currency}
        canWrite={ctx.role !== 'VIEWER'}
      />
    </div>
  );
}
