import { createHmac, timingSafeEqual } from 'node:crypto';
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

const API_BASE = 'https://api.twilio.com/2010-04-01';

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  defaultFrom?: string;
  messagingServiceSid?: string;
};

/** Twilio message statuses → our normalized set. */
function normalizeStatus(status: string | undefined): NormalizedStatus {
  switch ((status ?? '').toLowerCase()) {
    case 'queued':
    case 'accepted':
    case 'scheduled':
      return 'queued';
    case 'sending':
      return 'sending';
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'undelivered':
      return 'undelivered';
    case 'failed':
      return 'failed';
    case 'received':
      return 'received';
    default:
      return 'unknown';
  }
}

/** Twilio error codes worth another attempt; everything else is permanent. */
const RETRYABLE_CODES = new Set(['20429', '20500', '20503', '30001', '30002']);

export class TwilioProvider implements SmsProvider {
  readonly kind = 'twilio' as const;
  readonly configured: boolean;
  private readonly config: TwilioConfig;

  constructor(config: TwilioConfig) {
    this.config = config;
    this.configured = Boolean(config.accountSid && config.authToken);
  }

  private authHeader(): string {
    const token = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64');
    return `Basic ${token}`;
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    if (!this.configured) {
      throw new ProviderError('Twilio is not configured (set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN)');
    }

    const form = new URLSearchParams();
    form.set('To', input.to);
    form.set('Body', input.body);
    if (this.config.messagingServiceSid) form.set('MessagingServiceSid', this.config.messagingServiceSid);
    else form.set('From', input.from || this.config.defaultFrom || '');
    if (input.statusCallbackUrl) form.set('StatusCallback', input.statusCallbackUrl);

    const response = await fetch(`${API_BASE}/Accounts/${this.config.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
        // Twilio dedupes on this header, so a worker retry after a timeout
        // returns the original message rather than sending a second one.
        'I-Twilio-Idempotency-Token': input.idempotencyKey,
      },
      body: form.toString(),
    });

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok) {
      const code = payload.code !== undefined ? String(payload.code) : null;
      throw new ProviderError(String(payload.message ?? `Twilio returned ${response.status}`), {
        code,
        statusCode: response.status,
        retryable: response.status >= 500 || response.status === 429 || (code ? RETRYABLE_CODES.has(code) : false),
      });
    }

    return {
      providerMessageId: String(payload.sid),
      status: normalizeStatus(payload.status as string | undefined),
      segments: payload.num_segments ? Number(payload.num_segments) : undefined,
      costCents: payload.price ? Math.round(Math.abs(Number(payload.price)) * 100) : undefined,
      raw: payload,
    };
  }

  async getMessage(providerMessageId: string): Promise<ProviderMessage | null> {
    if (!this.configured) return null;
    const response = await fetch(
      `${API_BASE}/Accounts/${this.config.accountSid}/Messages/${providerMessageId}.json`,
      { headers: { Authorization: this.authHeader() } },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new ProviderError(`Twilio lookup failed with ${response.status}`, {
        statusCode: response.status,
        retryable: response.status >= 500,
      });
    }
    const payload = (await response.json()) as Record<string, unknown>;
    return {
      providerMessageId: String(payload.sid),
      status: normalizeStatus(payload.status as string | undefined),
      to: String(payload.to ?? ''),
      from: String(payload.from ?? ''),
      body: String(payload.body ?? ''),
      errorCode: payload.error_code ? String(payload.error_code) : null,
      errorMessage: payload.error_message ? String(payload.error_message) : null,
    };
  }

  async getMessageStatus(providerMessageId: string): Promise<NormalizedStatus> {
    const message = await this.getMessage(providerMessageId);
    return message?.status ?? 'unknown';
  }

  async getPhoneNumbers(): Promise<string[]> {
    if (!this.configured) return [];
    const response = await fetch(
      `${API_BASE}/Accounts/${this.config.accountSid}/IncomingPhoneNumbers.json?PageSize=100`,
      { headers: { Authorization: this.authHeader() } },
    );
    if (!response.ok) return [];
    const payload = (await response.json()) as { incoming_phone_numbers?: Array<{ phone_number: string }> };
    return (payload.incoming_phone_numbers ?? []).map((n) => n.phone_number);
  }

  /**
   * Twilio request validation: HMAC-SHA1 over the full URL with POST params
   * appended in sorted key order, compared in constant time.
   */
  verifyWebhook(request: WebhookRequest): boolean {
    const signature = request.headers['x-twilio-signature'];
    if (!signature || !this.config.authToken) return false;

    const sortedKeys = Object.keys(request.params).sort();
    const data = sortedKeys.reduce((acc, key) => acc + key + request.params[key], request.url);
    const expected = createHmac('sha1', this.config.authToken).update(Buffer.from(data, 'utf8')).digest('base64');

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async handleInbound(request: WebhookRequest): Promise<InboundMessage | null> {
    if (!this.verifyWebhook(request)) return null;
    const p = request.params;
    if (!p.MessageSid || !p.From) return null;
    return {
      providerMessageId: p.MessageSid,
      from: p.From,
      to: p.To ?? '',
      body: p.Body ?? '',
      receivedAt: new Date(),
      dedupeKey: `twilio:inbound:${p.MessageSid}`,
      raw: p,
    };
  }

  async handleDeliveryUpdate(request: WebhookRequest): Promise<DeliveryUpdate | null> {
    if (!this.verifyWebhook(request)) return null;
    const p = request.params;
    if (!p.MessageSid || !p.MessageStatus) return null;
    return {
      providerMessageId: p.MessageSid,
      status: normalizeStatus(p.MessageStatus),
      errorCode: p.ErrorCode ?? null,
      errorMessage: p.ErrorMessage ?? null,
      occurredAt: new Date(),
      // Same message can legitimately report sent then delivered, so the status
      // is part of the key.
      dedupeKey: `twilio:status:${p.MessageSid}:${p.MessageStatus}`,
      raw: p,
    };
  }
}
