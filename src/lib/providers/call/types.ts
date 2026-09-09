/**
 * The calling boundary.
 *
 * The default implementation hands the call to the operating system with a
 * `tel:` URI. That is genuinely all it can do — and the interface is shaped to
 * make that limitation impossible to paper over. `initiateCall` returns
 * `reportsConnection: false` for device telephony, and the disposition service
 * refuses to record a CONNECTED outcome as provider-reported unless the
 * provider actually says it can report one.
 */
export type CallProviderKind = 'device' | 'twilio_voice' | 'telnyx_voice';

export type InitiateCallInput = {
  to: string;
  from?: string | null;
  contactId: string;
};

export type InitiateCallResult = {
  /** What the client should do: open this URI, or nothing if server-dialled. */
  action: 'open_uri' | 'server_dialled';
  uri: string | null;
  externalCallId: string | null;
  /**
   * Whether this provider can tell us the call connected.
   *
   * False for device telephony. Everything downstream keys off this rather
   * than assuming, so the app never reports a connect rate it cannot observe.
   */
  reportsConnection: boolean;
};

export interface CallProvider {
  readonly kind: CallProviderKind;
  readonly configured: boolean;
  /** True when the provider emits real call progress events. */
  readonly reportsConnection: boolean;
  initiateCall(input: InitiateCallInput): Promise<InitiateCallResult>;
}

/**
 * Builds a `tel:` URI.
 *
 * Strips everything but digits and a leading `+`, so a stray character in a
 * stored number cannot turn into something else in a URI the OS will act on.
 */
export function telUri(phone: string): string | null {
  const trimmed = phone.trim();
  if (!trimmed) return null;

  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7) return null;

  return `tel:${hasPlus ? '+' : ''}${digits}`;
}
