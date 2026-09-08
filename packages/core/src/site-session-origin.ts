import { AsyncLocalStorage } from "node:async_hooks";

export type SiteSessionOrigin = { siteId: string; title: string };
const origins = new AsyncLocalStorage<SiteSessionOrigin>();

/** Request-local provenance, set only after the API validates a published Site version. */
export function withSiteSessionOrigin<T>(origin: SiteSessionOrigin, run: () => T): T {
  return origins.run(origin, run);
}

export function sessionCreationMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const { _opengeniSiteOrigin: _ignored, ...rest } = metadata;
  const origin = origins.getStore();
  return origin ? { ...rest, _opengeniSiteOrigin: origin } : rest;
}
