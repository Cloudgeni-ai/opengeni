import { postJob } from './transport';
import type { Fetcher, Job, Store } from './types';

export async function deliver(job: Job, endpoint: string, fetcher: Fetcher, store: Store, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const status = await postJob(fetcher, endpoint, job, signal);
  await store.save(job.id, status);
  return status;
}
