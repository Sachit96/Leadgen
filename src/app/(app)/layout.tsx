import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth/context';
import { countNeedingHuman } from '@/lib/services/conversations';
import { countUnread } from '@/lib/services/notifications';
import { countOpenTasks } from '@/lib/services/tasks';
import { Nav } from '@/components/nav';
import { ToastProvider } from '@/components/ui/toast';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const ctx = {
    organizationId: user.organizationId,
    userId: user.userId,
    role: user.role,
    timezone: user.organizationTimezone,
    user,
  };

  const [unread, needsHuman, tasks] = await Promise.all([
    countUnread(ctx),
    countNeedingHuman(ctx),
    countOpenTasks(ctx),
  ]);

  return (
    <ToastProvider>
      <div className="flex h-screen overflow-hidden">
        <Nav
          counts={{ inbox: unread, needsHuman, tasks }}
          organizationName={user.organizationName}
          userName={user.name}
          userRole={user.role}
        />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </ToastProvider>
  );
}
