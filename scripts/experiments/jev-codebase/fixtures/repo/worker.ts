import { deliver } from './delivery';
import type { JobQueue } from './queue';
import type { Fetcher, Store } from './types';

export async function runOne(queue: JobQueue, endpoint: string, fetcher: Fetcher, store: Store) {
  const envelope = queue.take();
  if (!envelope) return undefined;
  return deliver(envelope.job, endpoint, fetcher, store);
}
