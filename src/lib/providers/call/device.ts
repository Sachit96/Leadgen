import { telUri, type CallProvider, type InitiateCallInput, type InitiateCallResult } from './types';

/**
 * Device telephony — the default.
 *
 * The browser opens a `tel:` URI and the operating system's configured handler
 * takes the call: the phone app on mobile, or a paired handset via a continuity
 * feature on desktop. On Radar has no control over, and no visibility into,
 * what happens next.
 *
 * So `reportsConnection` is false. The only fact this provider establishes is
 * that the operator pressed the number.
 */
export class DeviceCallProvider implements CallProvider {
  readonly kind = 'device' as const;
  readonly configured = true;
  readonly reportsConnection = false;

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    return {
      action: 'open_uri',
      uri: telUri(input.to),
      externalCallId: null,
      reportsConnection: false,
    };
  }
}
