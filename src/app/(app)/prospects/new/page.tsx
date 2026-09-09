import Link from 'next/link';
import { requireCtx } from '@/lib/auth/context';
import { PageHeader } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button-styles';
import { NewProspectForm } from './form';

export const dynamic = 'force-dynamic';

export default async function NewProspectPage() {
  await requireCtx('prospect:write');
  return (
    <div className="p-6">
      <PageHeader
        title="Add a prospect"
        subtitle="The phone number is the identity — it is normalized and checked for duplicates on save."
        actions={
          <Link href="/prospects" className={buttonClass('ghost')}>
            ← All prospects
          </Link>
        }
      />
      <div className="max-w-2xl">
        <NewProspectForm />
      </div>
    </div>
  );
}
