import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { BrowserObservation, InteractionSemanticNodeValue } from "@opengeni/contracts";
import { BrowserSupervisor } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

e2e(
  "launches Chromium through the exact authenticated proxy before applying route emulation",
  async () => {
    const root = await mkdtemp("/tmp/ogr-");
    const proxyRequests: Array<{
      url: string;
      authorization: string | null;
      language: string | null;
    }> = [];
    const expectedAuthorization = `Basic ${Buffer.from("route-user:route-password").toString("base64")}`;
    const proxy = createServer((request, response) => {
      const authorization = request.headers["proxy-authorization"] ?? null;
      proxyRequests.push({
        url: request.url ?? "",
        authorization,
        language: request.headers["accept-language"] ?? null,
      });
      if (authorization !== expectedAuthorization) {
        response.writeHead(407, { "proxy-authenticate": 'Basic realm="OpenGeni test"' });
        response.end("proxy authentication required");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><title>Routed</title><main id="result">pending</main><script>
            const result = document.querySelector('#result');
            const route = [
              navigator.language,
              Intl.DateTimeFormat().resolvedOptions().timeZone,
              history.length,
            ].join('|');
            result.textContent = route;
            navigator.geolocation.getCurrentPosition(
              ({ coords }) => result.textContent = route + '|' + [
                coords.latitude.toFixed(4),
                coords.longitude.toFixed(4),
              ].join('|'),
              (error) => result.textContent = route + '|geo-error:' + error.code,
            );
          </script>`,
      );
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("proxy did not bind TCP");
    const supervisor = await BrowserSupervisor.open({
      rootDirectory: join(root, "state"),
      socketRootDirectory: join(root, "s"),
    });
    const reference = {
      browserSessionId: randomUUID(),
      controllerGeneration: `controller-${randomUUID()}`,
    };
    try {
      const created = await supervisor
        .createSession({
          ...reference,
          headed: false,
          initialUrl: "http://network-route.test/fixture",
          networkRoute: {
            routeId: randomUUID(),
            routeVersion: 1,
            authorityDigest: `ogr.${"a".repeat(43)}`,
            kind: "proxy",
            consistency: {
              dns: "proxy",
              expectedPublicIp: null,
              expectedRegion: "NO",
              locale: "nb-NO",
              timezone: "Europe/Oslo",
              geolocation: { latitude: 59.9139, longitude: 10.7522, accuracyMeters: 25 },
              webRtc: "disable_non_proxied_udp",
              stability: "session",
            },
            proxyUrl: `http://route-user:route-password@127.0.0.1:${address.port}/`,
          },
        })
        .catch((error) => {
          throw new Error(
            `proxy requests: ${JSON.stringify(
              proxyRequests.map((request) => ({
                url: request.url,
                authenticated: request.authorization === expectedAuthorization,
              })),
            )}`,
            { cause: error },
          );
        });
      const final = await observeUntil(
        supervisor,
        reference,
        created.observation.target.id,
        "nb-NO|Europe/Oslo|2",
      );
      expect(semanticText(final)).toContain("nb-NO|Europe/Oslo|2");
      expect(proxyRequests.some((request) => request.authorization === expectedAuthorization)).toBe(
        true,
      );
      expect(proxyRequests.some((request) => request.url.includes("network-route.test"))).toBe(
        true,
      );
      expect(
        proxyRequests.some(
          (request) => request.url.includes("network-route.test") && request.language === "nb-NO",
        ),
      ).toBe(true);
    } finally {
      await supervisor.close().catch(() => undefined);
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

async function observeUntil(
  supervisor: BrowserSupervisor,
  reference: { browserSessionId: string; controllerGeneration: string },
  targetId: string,
  text: string,
): Promise<BrowserObservation> {
  const deadline = Date.now() + 10_000;
  let current = await supervisor.observe(reference, targetId);
  while (Date.now() < deadline && !semanticText(current).includes(text)) {
    await Bun.sleep(50);
    current = await supervisor.observe(reference, targetId);
  }
  return current;
}

function semanticText(observation: BrowserObservation): string {
  const values: string[] = [];
  const visit = (node: InteractionSemanticNodeValue) => {
    if (node.name) values.push(node.name);
    if (typeof node.value === "string") values.push(node.value);
    for (const child of node.children ?? []) visit(child);
  };
  const semantic = observation.semantic;
  if (!semantic) return "";
  for (const root of semantic.kind === "snapshot" ? semantic.roots : semantic.changed) visit(root);
  return values.join("\n");
}
