import { env } from '@/lib/env';
import { MockSmsProvider } from './mock';
import { TelnyxProvider } from './telnyx';
import { TwilioProvider } from './twilio';
import type { ProviderKind, SmsProvider } from './types';

export * from './types';
export { MockSmsProvider } from './mock';
export { TwilioProvider } from './twilio';
export { TelnyxProvider } from './telnyx';

declare global {
  var __onRadarSmsProvider: SmsProvider | undefined;
}

/**
 * Resolves the SMS provider from configuration.
 *
 * A provider that is selected but not configured falls back to the mock so the
 * app stays usable — but `configured` is false on that path and the settings
 * screen surfaces it, so nobody mistakes a mock send for a real one.
 */
export function getSmsProvider(): SmsProvider {
  if (globalThis.__onRadarSmsProvider) return globalThis.__onRadarSmsProvider;

  const e = env();
  let provider: SmsProvider;

  switch (e.SMS_PROVIDER) {
    case 'twilio': {
      const twilio = new TwilioProvider({
        accountSid: e.TWILIO_ACCOUNT_SID ?? '',
        authToken: e.TWILIO_AUTH_TOKEN ?? '',
        defaultFrom: e.TWILIO_PHONE_NUMBER,
        messagingServiceSid: e.TWILIO_MESSAGING_SERVICE_SID,
      });
      provider = twilio.configured ? twilio : new MockSmsProvider();
      break;
    }
    case 'telnyx': {
      const telnyx = new TelnyxProvider({
        apiKey: e.TELNYX_API_KEY ?? '',
        defaultFrom: e.TELNYX_PHONE_NUMBER,
        messagingProfileId: e.TELNYX_MESSAGING_PROFILE_ID,
        publicKey: e.TELNYX_PUBLIC_KEY,
      });
      provider = telnyx.configured ? telnyx : new MockSmsProvider();
      break;
    }
    default:
      provider = new MockSmsProvider();
  }

  globalThis.__onRadarSmsProvider = provider;
  return provider;
}

/** Test/demo override. */
export function setSmsProvider(provider: SmsProvider | undefined): void {
  globalThis.__onRadarSmsProvider = provider;
}

export function defaultFromNumber(): string | null {
  const e = env();
  if (e.SMS_PROVIDER === 'twilio' && e.TWILIO_PHONE_NUMBER) return e.TWILIO_PHONE_NUMBER;
  if (e.SMS_PROVIDER === 'telnyx' && e.TELNYX_PHONE_NUMBER) return e.TELNYX_PHONE_NUMBER;
  return '+15550001111';
}

export function providerKind(): ProviderKind {
  return getSmsProvider().kind;
}
