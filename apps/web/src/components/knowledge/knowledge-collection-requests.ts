import type { KnowledgeEntryListResponse } from "@opengeni/sdk";

// Share only in-flight reads within one mounted tree and authorization/filter
// context. Every expansion after settlement must reauthorize with the server.
type Page = Pick<KnowledgeEntryListResponse, "entries" | "nextCursor">;

export class KnowledgeCollectionRequests {
  readonly id = crypto.randomUUID();
  private readonly pending = new Map<string, Promise<Page>>();

  load(key: string, fetchPage: () => Promise<Page>): Promise<Page> {
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = Promise.resolve()
      .then(fetchPage)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }
}
