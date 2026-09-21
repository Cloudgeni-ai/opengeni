import type { Fetcher, Job } from './types';

export async function postJob(fetcher: Fetcher, endpoint: string, job: Job, signal?: AbortSignal) {
  const response = await fetcher(endpoint, {
    method: 'POST', body: JSON.stringify(job), signal,
  });
  if (response.status >= 500) throw new Error('delivery unavailable');
  return response.status;
}
