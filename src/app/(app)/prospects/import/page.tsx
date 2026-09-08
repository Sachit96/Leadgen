import Link from 'next/link';
import { requireCtx } from '@/lib/auth/context';
import { listCampaigns } from '@/lib/services/campaigns';
import { PageHeader } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/buttons';
import { ImportWizard } from './wizard';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  const ctx = await requireCtx('prospect:import');
  const campaigns = await listCampaigns(ctx);

  return (
    <div className="p-6">
      <PageHeader
        title="Import prospects"
        subtitle="Upload a CSV, review exactly what will happen, then commit. Nothing is written until you confirm."
        actions={
          <Link href="/prospects" className={buttonClass('ghost')}>
            ← All prospects
          </Link>
        }
      />
      <ImportWizard
        campaigns={campaigns
          .filter((c) => c.campaign.status !== 'ARCHIVED')
          .map((c) => ({ id: c.campaign.id, name: c.campaign.name }))}
      />
    </div>
  );
}
