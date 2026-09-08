import type { NextRequest } from 'next/server';
import { env } from '@/lib/env';
import type { WebhookRequest } from '@/lib/providers/sms';

/**
 * Normalizes an incoming webhook into the provider-agnostic shape.
 *
 * The raw body is preserved verbatim because signature verification is computed
 * over it — re-serializing parsed JSON would break Telnyx's Ed25519 check.
 */
export async function readWebhookRequest(request: NextRequest): Promise<WebhookRequest> {
  const rawBody = await request.text();
  const contentType = request.headers.get('content-type') ?? '';

  const params: Record<string, string> = {};
  if (contentType.includes('application/json')) {
    try {
      flatten(JSON.parse(rawBody), params);
    } catch {
      // Leave params empty; the provider decides what to do with the raw body.
    }
  } else {
    for (const [key, value] of new URLSearchParams(rawBody)) params[key] = value;
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  return { url: publicUrl(request), headers, rawBody, params };
}

/**
 * The URL the provider signed. Behind a proxy the request URL is the internal
 * one, so the configured public URL wins when it is set.
 */
function publicUrl(request: NextRequest): string {
  const configured = env().NEXT_PUBLIC_APP_URL;
  const parsed = new URL(request.url);
  if (configured) return `${configured.replace(/\/$/, '')}${parsed.pathname}${parsed.search}`;
  return request.url;
}

function flatten(value: unknown, out: Record<string, string>, prefix = ''): void {
  if (value === null || value === undefined) return;
  if (typeof value !== 'object') {
    out[prefix] = String(value);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === 'object') flatten(child, out, path);
    else if (child !== undefined) out[path] = String(child);
  }
}
