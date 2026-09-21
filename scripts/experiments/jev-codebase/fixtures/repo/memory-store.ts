import type { Store } from './types';

export class MemoryStore implements Store {
  readonly statuses = new Map<string, number>();
  async save(id: string, status: number) { this.statuses.set(id, status); }
}
