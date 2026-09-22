import type { Job } from './types';

export interface Envelope { job: Job; enqueuedAt: number }
export class JobQueue {
  private pending: Envelope[] = [];
  enqueue(job: Job): void {
    this.pending.push({ job: { ...job }, enqueuedAt: Date.now() });
  }
  take(): Envelope | undefined { return this.pending.shift(); }
}
