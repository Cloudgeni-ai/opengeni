import { OpenGeniClient } from "@opengeni/sdk";
import { createHostHandler } from "./host-handler";
if (process.env.EMBED_DEMO_LOCAL_AUTH !== "true")
  throw new Error(
    "Configure host authentication or explicitly enable loopback demo authentication",
  );
const workspaceId = process.env.OPENGENI_WORKSPACE_ID;
const apiKey = process.env.OPENGENI_API_KEY;
const baseUrl = process.env.OPENGENI_API_BASE_URL;
if (!workspaceId || !apiKey || !baseUrl)
  throw new Error("Server-side workspace, organization key and API base URL are required");
const returnUrl =
  process.env.EMBED_DEMO_RETURN_URL ?? "http://127.0.0.1:3102/?connected=%2f#connections";
const appOrigin = "http://127.0.0.1:3102";
const handler = createHostHandler({
  service: new OpenGeniClient({ baseUrl, apiKey }),
  authenticate: async (request) =>
    request.headers.get("host") === "127.0.0.1:3102"
      ? {
          externalId: process.env.EMBED_DEMO_EXTERNAL_USER ?? "demo-user",
          source: "embedded-product-demo",
          workspaceId,
        }
      : null,
  authorizeMutation: async (request) =>
    request.headers.get("origin") === appOrigin &&
    request.headers.get("x-embedded-product") === "1",
  returnUrl: () => returnUrl,
  siteHref: (_actor, siteId) => `${appOrigin}/?site=${encodeURIComponent(siteId)}`,
});
Bun.serve({ hostname: "127.0.0.1", port: 4102, maxRequestBodySize: 65_536, fetch: handler });
console.log("Loopback-only embedded product backend listening on 127.0.0.1:4102");
