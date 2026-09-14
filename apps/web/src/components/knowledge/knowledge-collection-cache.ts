import type { KnowledgeEntryListResponse } from "@opengeni/sdk";

// Local to one mounted tree and its current authorization/filter context. Never
// persist Knowledge rows in browser storage or share them between principals.
export const COLLECTION_CACHE_TTL_MS = 15_000;
const MAX_CACHED_PAGES = 64;
type Page = Pick<KnowledgeEntryListResponse, "entries" | "nextCursor">;
type CachedPage = { page: Page; expiresAt: number };

export class KnowledgeCollectionCache {
  readonly id = crypto.randomUUID();
  private readonly pages = new Map<string, CachedPage>();
  private readonly pending = new Map<string, Promise<Page>>();

  peek(key: string): Page | undefined {
    const cached = this.pages.get(key);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now()) {
      this.pages.delete(key);
      return undefined;
    }
    return cached.page;
  }

  load(key: string, fetchPage: () => Promise<Page>): Promise<Page> {
    const cached = this.peek(key);
    if (cached) return Promise.resolve(cached);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = Promise.resolve()
      .then(fetchPage)
      .then((page) => {
        this.pages.delete(key);
        this.pages.set(key, { page, expiresAt: Date.now() + COLLECTION_CACHE_TTL_MS });
        while (this.pages.size > MAX_CACHED_PAGES) {
          this.pages.delete(this.pages.keys().next().value!);
        }
        return page;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }
}
