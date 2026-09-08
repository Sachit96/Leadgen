/**
 * The SMS boundary.
 *
 * No business logic imports a vendor SDK. Everything above this line speaks
 * `SmsProvider`; everything below translates one vendor's API into it.
 */
export type ProviderKind = 'twilio' | 'telnyx' | 'mock';

export type SendMessageInput = {
  to: string;
  from: string;
  body: string;
  /** Passed to the provider so a retry cannot produce a duplicate send. */
  idempotencyKey: string;
  statusCallbackUrl?: string;
};

export type SendMessageResult = {
  providerMessageId: string;
  status: NormalizedStatus;
  segments?: number;
  costCents?: number;
  raw?: unknown;
};

export type NormalizedStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'undelivered'
  | 'failed'
  | 'received'
  | 'unknown';

export type ProviderMessage = {
  providerMessageId: string;
  status: NormalizedStatus;
  to: string;
  from: string;
  body: string;
  errorCode?: string | null;
  errorMessage?: string | null;
};

/** A normalized inbound SMS, whatever shape the provider posted. */
export type InboundMessage = {
  providerMessageId: string;
  from: string;
  to: string;
  body: string;
  receivedAt: Date;
  /** Stable key for webhook-retry deduplication. */
  dedupeKey: string;
  raw: unknown;
};

export type DeliveryUpdate = {
  providerMessageId: string;
  status: NormalizedStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  occurredAt: Date;
  dedupeKey: string;
  raw: unknown;
};

export type WebhookRequest = {
  url: string;
  headers: Record<string, string>;
  rawBody: string;
  /** Parsed form/JSON body, whichever the provider uses. */
  params: Record<string, string>;
};

export class ProviderError extends Error {
  readonly providerCode: string | null;
  readonly retryable: boolean;
  readonly statusCode: number | null;

  constructor(message: string, opts: { code?: string | null; retryable?: boolean; statusCode?: number | null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.providerCode = opts.code ?? null;
    this.retryable = opts.retryable ?? false;
    this.statusCode = opts.statusCode ?? null;
  }
}

export interface SmsProvider {
  readonly kind: ProviderKind;
  /** False when credentials are missing; the app then refuses to "send". */
  readonly configured: boolean;

  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  getMessage(providerMessageId: string): Promise<ProviderMessage | null>;
  getMessageStatus(providerMessageId: string): Promise<NormalizedStatus>;
  getPhoneNumbers(): Promise<string[]>;

  /** Returns null when the signature does not verify. */
  handleInbound(request: WebhookRequest): Promise<InboundMessage | null>;
  handleDeliveryUpdate(request: WebhookRequest): Promise<DeliveryUpdate | null>;
  verifyWebhook(request: WebhookRequest): boolean;
}

/** Statuses after which no further transition is expected. */
export const TERMINAL_STATUSES: NormalizedStatus[] = ['delivered', 'undelivered', 'failed'];

export function isTerminal(status: NormalizedStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
