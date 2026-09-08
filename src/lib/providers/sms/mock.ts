import { randomUUID } from 'node:crypto';
import type {
  DeliveryUpdate,
  InboundMessage,
  NormalizedStatus,
  ProviderMessage,
  SendMessageInput,
  SendMessageResult,
  SmsProvider,
  WebhookRequest,
} from './types';
import { ProviderError } from './types';

/**
 * In-process SMS provider for tests and demo mode.
 *
 * It is a real implementation of the interface — messages are stored, statuses
 * transition, and webhooks can be simulated — so the whole pipeline (queue →
 * provider → delivery webhook → analytics) is exercised end to end without
 * credentials or network access.
 */
export type MockSentMessage = {
  providerMessageId: string;
  to: string;
  from: string;
  body: string;
  status: NormalizedStatus;
  idempotencyKey: string;
  sentAt: Date;
};

export class MockSmsProvider implements SmsProvider {
  readonly kind = 'mock' as const;
  readonly configured = true;

  private readonly sent = new Map<string, MockSentMessage>();
  private readonly byIdempotencyKey = new Map<string, string>();

  /** Numbers that always fail, so failure handling can be tested on demand. */
  failNumbers = new Set<string>();
  /** When set, the next send throws this error once. */
  nextError: ProviderError | null = null;

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      throw error;
    }

    const existingId = this.byIdempotencyKey.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.sent.get(existingId)!;
      return { providerMessageId: existing.providerMessageId, status: existing.status, raw: existing };
    }

    if (this.failNumbers.has(input.to)) {
      throw new ProviderError(`Mock provider: ${input.to} is configured to fail`, {
        code: '21211',
        retryable: false,
      });
    }

    const providerMessageId = `MOCK${randomUUID().replace(/-/g, '')}`;
    const record: MockSentMessage = {
      providerMessageId,
      to: input.to,
      from: input.from,
      body: input.body,
      status: 'sent',
      idempotencyKey: input.idempotencyKey,
      sentAt: new Date(),
    };
    this.sent.set(providerMessageId, record);
    this.byIdempotencyKey.set(input.idempotencyKey, providerMessageId);

    const segments = Math.max(1, Math.ceil(input.body.length / 153));
    return { providerMessageId, status: 'sent', segments, costCents: segments, raw: record };
  }

  async getMessage(providerMessageId: string): Promise<ProviderMessage | null> {
    const record = this.sent.get(providerMessageId);
    if (!record) return null;
    return {
      providerMessageId,
      status: record.status,
      to: record.to,
      from: record.from,
      body: record.body,
    };
  }

  async getMessageStatus(providerMessageId: string): Promise<NormalizedStatus> {
    return this.sent.get(providerMessageId)?.status ?? 'unknown';
  }

  async getPhoneNumbers(): Promise<string[]> {
    return ['+15550001111'];
  }

  /** Mock webhooks are trusted; the route guards them with a shared token. */
  verifyWebhook(_request: WebhookRequest): boolean {
    return true;
  }

  async handleInbound(request: WebhookRequest): Promise<InboundMessage | null> {
    const p = request.params;
    if (!p.From) return null;
    const providerMessageId = p.MessageSid ?? `MOCKIN${randomUUID().replace(/-/g, '')}`;
    return {
      providerMessageId,
      from: p.From,
      to: p.To ?? '',
      body: p.Body ?? '',
      receivedAt: new Date(),
      dedupeKey: `mock:inbound:${providerMessageId}`,
      raw: p,
    };
  }

  async handleDeliveryUpdate(request: WebhookRequest): Promise<DeliveryUpdate | null> {
    const p = request.params;
    if (!p.MessageSid || !p.MessageStatus) return null;
    const status = p.MessageStatus as NormalizedStatus;
    const record = this.sent.get(p.MessageSid);
    if (record) record.status = status;
    return {
      providerMessageId: p.MessageSid,
      status,
      errorCode: p.ErrorCode ?? null,
      errorMessage: p.ErrorMessage ?? null,
      occurredAt: new Date(),
      dedupeKey: `mock:status:${p.MessageSid}:${status}`,
      raw: p,
    };
  }

  /* ---------------------------------------------- test/demo control surface */

  outbox(): MockSentMessage[] {
    return [...this.sent.values()].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  }

  lastMessage(): MockSentMessage | undefined {
    return this.outbox().at(-1);
  }

  reset(): void {
    this.sent.clear();
    this.byIdempotencyKey.clear();
    this.failNumbers.clear();
    this.nextError = null;
  }
}
