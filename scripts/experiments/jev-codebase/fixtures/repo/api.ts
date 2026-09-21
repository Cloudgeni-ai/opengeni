import { recordAccepted } from './audit';
import type { AuditSink } from './audit';
import { readConfig } from './config';
import { deliver } from './delivery';
import type { JobQueue } from './queue';
import type { Fetcher, Job, RuntimeEnv, Store } from './types';

export async function submit(job: Job, signal: AbortSignal, deps: {
  env: RuntimeEnv; queue: JobQueue; fetcher: Fetcher; store: Store; audit: AuditSink;
}) {
  const config = readConfig(deps.env);
  if (config.queued) {
    deps.queue.enqueue(job);
    await recordAccepted(config.audit, deps.audit, job.id);
    return 202;
  }
  const status = await deliver(job, config.endpoint, deps.fetcher, deps.store, signal);
  await recordAccepted(config.audit, deps.audit, job.id);
  return status;
}
