import Link from 'next/link';
import { requireCtx } from '@/lib/auth/context';
import { Card, PageHeader } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button-styles';
import { NewCampaignForm } from './form';

export const dynamic = 'force-dynamic';

export default async function NewCampaignPage() {
  await requireCtx('campaign:write');
  return (
    <div className="p-6">
      <PageHeader
        title="New campaign"
        subtitle="You will add the sequence and message variants next."
        actions={
          <Link href="/campaigns" className={buttonClass('ghost')}>
            ← All campaigns
          </Link>
        }
      />
      <div className="max-w-xl">
        <Card>
          <NewCampaignForm />
        </Card>
      </div>
    </div>
  );
}
