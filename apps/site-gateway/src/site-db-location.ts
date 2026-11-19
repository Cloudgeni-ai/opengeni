import { errorMessage } from "@opengeni/contracts/values";

/**
 * Where Site SQL databases live (docs/site-data.md, "Location").
 *
 * Every Site's database is a SQLite Durable Object named by its Site id. New
 * and relocated databases live in Cloudflare's EU jurisdiction
 * (`SITE_DB.jurisdiction("eu").idFromName(siteId)`), so their data is stored
 * only in the EU. Databases created before that were named in the plain
 * namespace (`SITE_DB.idFromName(siteId)`, the "legacy" object), which
 * Cloudflare may place anywhere. A jurisdiction-scoped id is a different
 * object, so the EU object copies a legacy database the first time it is
 * used (`site-db-relocation.ts`) and the legacy object is kept, frozen, until
 * an explicit cleanup.
 *
 * These headers travel only between the gateway and its own Durable Objects
 * (stub fetches the gateway builds itself), never from or to a client.
 */

/** The jurisdiction Site databases live in. */
export const SITE_DB_JURISDICTION = "eu";

/** Who is calling a `SiteDatabase` object. Absent: an earlier gateway release (legacy object). */
export const SITE_DB_ROLE_HEADER = "x-og-site-db-role";
/** The Site id, sent with every role. */
export const SITE_DB_SITE_HEADER = "x-og-site-db-site";
/** On responses: where the request was served, `eu` or `legacy`. */
export const SITE_DB_LOCATION_HEADER = "x-og-site-db-location";
/** On responses served from the legacy object: why the database has not moved yet. */
export const SITE_DB_RELOCATION_ERROR_HEADER = "x-og-site-db-relocation-error";

/**
 * `primary`: the gateway calling a Site's EU object, which serves the
 * request (relocating a legacy database first). `relay`: the EU object
 * calling the Site's legacy object, to copy it or to serve a request while
 * the database could not move.
 */
export type SiteDbRole = "primary" | "relay";

export type DurableObjectStubLike = {
  fetch(input: string, init?: RequestInit): Promise<Response>;
};

/** The Durable Object namespace binding (`[[durable_objects.bindings]]`). */
export type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
  jurisdiction?(name: string): DurableObjectNamespaceLike;
};

const primaries = new WeakMap<object, DurableObjectNamespaceLike>();

/**
 * The namespace Site databases live in: the binding restricted to the EU
 * jurisdiction. Throws when the runtime cannot restrict it, so a database is
 * never created outside the EU by mistake.
 *
 * Local workerd (`wrangler dev`, Miniflare) refuses jurisdictions ("not
 * implemented in workerd"). There the EU namespace is emulated by naming
 * objects `eu:<siteId>`, a separate object like the real one, so relocation
 * runs the same way in development and tests. Cloudflare itself supports
 * jurisdictions, so the emulation never applies to a deployed Worker.
 */
export function primarySiteDbNamespace(
  binding: DurableObjectNamespaceLike,
): DurableObjectNamespaceLike {
  const cached = primaries.get(binding);
  if (cached) return cached;
  if (typeof binding.jurisdiction !== "function")
    throw new Error("The SITE_DB binding cannot be restricted to a jurisdiction");
  let primary: DurableObjectNamespaceLike;
  try {
    primary = binding.jurisdiction(SITE_DB_JURISDICTION);
  } catch (error) {
    if (!/not implemented in workerd/iu.test(errorMessage(error))) throw error;
    primary = {
      idFromName: (name) => binding.idFromName(`${SITE_DB_JURISDICTION}:${name}`),
      get: (id) => binding.get(id),
    };
  }
  primaries.set(binding, primary);
  return primary;
}

/** The stub of a Site's object in `namespace`. */
export function siteDbStub(
  namespace: DurableObjectNamespaceLike,
  siteId: string,
): DurableObjectStubLike {
  return namespace.get(namespace.idFromName(siteId));
}
