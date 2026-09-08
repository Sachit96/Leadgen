import { requireCtx } from '@/lib/auth/context';
import { ConversationList } from './conversation-list';

export const dynamic = 'force-dynamic';

/**
 * Keeps the conversation list mounted across selections, so moving between
 * conversations does not reset the list's scroll position or refetch it.
 */
export default async function InboxLayout({ children }: { children: React.ReactNode }) {
  await requireCtx('conversation:read');

  return (
    <div className="flex h-screen">
      <ConversationList />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
