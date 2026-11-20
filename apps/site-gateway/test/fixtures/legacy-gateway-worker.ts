/**
 * A Worker for test/site-db-relocation.miniflare.test.ts: the real gateway,
 * plus a test-only path that reaches a Site's legacy Durable Object (plain
 * `idFromName(siteId)`) the way an earlier gateway release did, with no
 * location headers, or as the Site's EU object would (`x-test-role: relay`).
 *
 * `POST /_test/legacy/<siteId>/<path>` → the legacy object's `/<path>`.
 */
import gateway, { SiteDatabase } from "../../src/index";
import { SITE_DB_ROLE_HEADER, SITE_DB_SITE_HEADER } from "../../src/site-db-location";
import type { GatewayEnv, WaitUntil } from "../../src/env";

export { SiteDatabase };

type Namespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
};

export default {
  async fetch(request: Request, env: GatewayEnv, ctx: WaitUntil): Promise<Response> {
    const url = new URL(request.url);
    const legacy = /^\/_test\/legacy\/([0-9a-f-]{36})\/([a-z/]+)$/u.exec(url.pathname);
    if (!legacy) return gateway.fetch(request, env, ctx);
    const [, site, path] = legacy;
    const namespace = env.SITE_DB as Namespace;
    const headers = new Headers({ "content-type": "application/json" });
    const role = request.headers.get("x-test-role");
    if (role) {
      headers.set(SITE_DB_ROLE_HEADER, role);
      headers.set(SITE_DB_SITE_HEADER, site!);
    }
    return namespace.get(namespace.idFromName(site!)).fetch(`https://site-db.internal/${path}`, {
      method: "POST",
      headers,
      body: await request.arrayBuffer(),
    });
  },
};
