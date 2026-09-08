import { createPublicKey, verify as verifySignature } from 'node:crypto';
import {
  ProviderError,
  type DeliveryUpdate,
  type InboundMessage,
  type NormalizedStatus,
  type ProviderMessage,
  type SendMessageInput,
  type SendMessageResult,
  type SmsProvider,
  type WebhookRequest,
} from './types';

const API_BASE = 'https://api.telnyx.com/v2';

export type TelnyxConfig = {
  apiKey: string;
  defaultFrom?: string;
  messagingProfileId?: string;
  /** Base64 Ed25519 public key from the Telnyx portal. */
  publicKey?: string;
};

function normalizeStatus(status: string | undefined): NormalizedStatus {
  switch ((status ?? '').toLowerCase()) {
    case 'queued':
      return 'queued';
    case 'sending':
      return 'sending';
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'delivery_failed':
    case 'delivery_unconfirmed':
      return 'undelivered';
    case 'failed':
    case 'sending_failed':
      return 'failed';
    case 'received':
      return 'received';
    default:
      return 'unknown';
  }
}

export class TelnyxProvider implements SmsProvider {
  readonly kind = 'telnyx' as const;
  readonly configured: boolean;
  private readonly config: TelnyxConfig;

  constructor(config: TelnyxConfig) {
    this.config = config;
    this.configured = Boolean(config.apiKey);
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    if (!this.configured) throw new ProviderError('Telnyx is not configured (set TELNYX_API_KEY)');

    const body: Record<string, unknown> = {
      to: input.to,
      text: input.body,
    };
    if (this.config.messagingProfileId) body.messaging_profile_id = this.config.messagingProfileId;
    body.from = input.from || this.config.defaultFrom;
    if (input.statusCallbackUrl) body.webhook_url = input.statusCallbackUrl;

    const response = await fetch(`${API_BASE}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify(body),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      data?: { id?: string; to?: Array<{ status?: string }>; parts?: number };
      errors?: Array<{ code?: string; detail?: string; title?: string }>;
    };

    if (!response.ok) {
      const first = payload.errors?.[0];
      throw new ProviderError(first?.detail ?? first?.title ?? `Telnyx returned ${response.status}`, {
        code: first?.code ?? null,
        statusCode: response.status,
        retryable: response.status >= 500 || response.status === 429,
      });
    }

    return {
      providerMessageId: String(payload.data?.id),
      status: normalizeStatus(payload.data?.to?.[0]?.status),
      segments: payload.data?.parts,
      raw: payload,
    };
  }

  async getMessage(providerMessageId: string): Promise<ProviderMessage | null> {
    if (!this.configured) return null;
    const response = await fetch(`${API_BASE}/messages/${providerMessageId}`, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new ProviderError(`Telnyx lookup failed with ${response.status}`, {
        statusCode: response.status,
        retryable: response.status >= 500,
      });
    }
    const payload = (await response.json()) as {
      data?: {
        id?: string;
        text?: string;
        from?: { phone_number?: string };
        to?: Array<{ phone_number?: string; status?: string }>;
        errors?: Array<{ code?: string; detail?: string }>;
      };
    };
    const data = payload.data;
    if (!data) return null;
    return {
      providerMessageId: String(data.id),
      status: normalizeStatus(data.to?.[0]?.status),
      to: data.to?.[0]?.phone_number ?? '',
      from: data.from?.phone_number ?? '',
      body: data.text ?? '',
      errorCode: data.errors?.[0]?.code ?? null,
      errorMessage: data.errors?.[0]?.detail ?? null,
    };
  }

  async getMessageStatus(providerMessageId: string): Promise<NormalizedStatus> {
    const message = await this.getMessage(providerMessageId);
    return message?.status ?? 'unknown';
  }

  async getPhoneNumbers(): Promise<string[]> {
    if (!this.configured) return [];
    const response = await fetch(`${API_BASE}/phone_numbers?page[size]=100`, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { data?: Array<{ phone_number?: string }> };
    return (payload.data ?? []).map((n) => n.phone_number ?? '').filter(Boolean);
  }

  /**
   * Telnyx signs `timestamp|rawBody` with Ed25519. The timestamp is checked
   * against a five-minute window so a captured request cannot be replayed.
   */
  verifyWebhook(request: WebhookRequest): boolean {
    const signature = request.headers['telnyx-signature-ed25519'];
    const timestamp = request.headers['telnyx-timestamp'];
    if (!signature || !timestamp || !this.config.publicKey) return false;

    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > 300) return false;

    try {
      const key = createPublicKey({
        key: Buffer.concat([
          Buffer.from('302a300506032b6570032100', 'hex'),
          Buffer.from(this.config.publicKey, 'base64'),
        ]),
        format: 'der',
        type: 'spki',
      });
      return verifySignature(
        null,
        Buffer.from(`${timestamp}|${request.rawBody}`, 'utf8'),
        key,
        Buffer.from(signature, 'base64'),
      );
    } catch {
      return false;
    }
  }

  private parseEvent(request: WebhookRequest): { type: string; payload: Record<string, unknown>; id: string } | null {
    try {
      const parsed = JSON.parse(request.rawBody) as {
        data?: { id?: string; event_type?: string; payload?: Record<string, unknown> };
      };
      if (!parsed.data?.event_type || !parsed.data.payload) return null;
      return {
        type: parsed.data.event_type,
        payload: parsed.data.payload,
        id: String(parsed.data.id ?? ''),
      };
    } catch {
      return null;
    }
  }

  async handleInbound(request: WebhookRequest): Promise<InboundMessage | null> {
    if (!this.verifyWebhook(request)) return null;
    const event = this.parseEvent(request);
    if (!event || event.type !== 'message.received') return null;

    const p = event.payload as {
      id?: string;
      text?: string;
      from?: { phone_number?: string };
      to?: Array<{ phone_number?: string }>;
    };
    if (!p.id || !p.from?.phone_number) return null;

    return {
      providerMessageId: p.id,
      from: p.from.phone_number,
      to: p.to?.[0]?.phone_number ?? '',
      body: p.text ?? '',
      receivedAt: new Date(),
      dedupeKey: `telnyx:inbound:${p.id}`,
      raw: event.payload,
    };
  }

  async handleDeliveryUpdate(request: WebhookRequest): Promise<DeliveryUpdate | null> {
    if (!this.verifyWebhook(request)) return null;
    const event = this.parseEvent(request);
    if (!event || !event.type.startsWith('message.')) return null;
    if (event.type === 'message.received') return null;

    const p = event.payload as {
      id?: string;
      to?: Array<{ status?: string }>;
      errors?: Array<{ code?: string; detail?: string }>;
    };
    if (!p.id) return null;
    const status = normalizeStatus(p.to?.[0]?.status);

    return {
      providerMessageId: p.id,
      status,
      errorCode: p.errors?.[0]?.code ?? null,
      errorMessage: p.errors?.[0]?.detail ?? null,
      occurredAt: new Date(),
      dedupeKey: `telnyx:status:${p.id}:${status}`,
      raw: event.payload,
    };
  }
}
