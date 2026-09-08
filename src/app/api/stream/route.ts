import { type NextRequest } from 'next/server';
import { requireCtx } from '@/lib/auth/context';
import { activitySince } from '@/lib/services/activity';
import { countNeedingHuman } from '@/lib/services/conversations';
import { countUnread } from '@/lib/services/notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POLL_INTERVAL_MS = 3_000;
const MAX_STREAM_MS = 5 * 60_000;

/**
 * Server-Sent Events feed for the inbox and the notification bell.
 *
 * Backed by a cursor over the activity table rather than an in-process emitter,
 * so it survives restarts and works with more than one app instance without a
 * vendor realtime service. Only surfaces that need live updates subscribe.
 */
export async function GET(request: NextRequest) {
  const ctx = await requireCtx();
  const encoder = new TextEncoder();
  const startedAt = Date.now();
  let cursor = new Date();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };

      request.signal.addEventListener('abort', close);
      send('ready', { at: cursor.toISOString() });

      const timer = setInterval(async () => {
        if (closed) return;
        if (Date.now() - startedAt > MAX_STREAM_MS) {
          // Bounded lifetime; EventSource reconnects on its own.
          send('reconnect', {});
          close();
          return;
        }

        try {
          const events = await activitySince(ctx, cursor, 50);
          if (events.length > 0) {
            cursor = events[events.length - 1]!.createdAt;
            send('activity', events);
          }

          const [unread, needsHuman] = await Promise.all([countUnread(ctx), countNeedingHuman(ctx)]);
          send('counts', { unread, needsHuman });
        } catch {
          close();
        }
      }, POLL_INTERVAL_MS);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
