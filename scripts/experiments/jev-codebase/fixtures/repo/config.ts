import type { RuntimeEnv } from './types';

export function readConfig(env: RuntimeEnv) {
  return {
    endpoint: env.DELIVERY_URL ?? 'https://delivery.invalid/jobs',
    queued: env.DELIVERY_MODE === 'queued',
    audit: env.AUDIT_ENABLED === 'true',
  };
}
