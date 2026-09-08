import { EmptyState } from '@/components/ui/primitives';

export default function InboxIndexPage() {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <EmptyState
        title="Select a conversation"
        description="Pick a conversation on the left to read the thread, see the prospect's context, and reply."
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="size-10">
            <path d="M3 12h4l2 3h6l2-3h4M3 12V6a2 2 0 012-2h14a2 2 0 012 2v6m-18 0v6a2 2 0 002 2h14a2 2 0 002-2v-6" />
          </svg>
        }
      />
    </div>
  );
}
