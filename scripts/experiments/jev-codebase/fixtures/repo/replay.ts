import { postJob } from './transport';
import type { Fetcher, Job } from './types';

// Emergency console helper; callers provide an already-selected endpoint.
export function replay(job: Job, endpoint: string, fetcher: Fetcher) {
  return postJob(fetcher, endpoint, job);
}
