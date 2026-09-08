import { resetEnvCache } from '@/lib/env';

/** Minimum viable environment for tests: no real credentials, all mocks. */
export function installTestEnv(overrides: Record<string, string> = {}): void {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test/test',
    SESSION_SECRET: 'test-session-secret-that-is-long-enough-000',
    SMS_PROVIDER: 'mock',
    AI_PROVIDER: 'mock',
    CALENDAR_PROVIDER: 'internal',
    LOG_LEVEL: 'error',
    ...overrides,
  });
  resetEnvCache();
}
