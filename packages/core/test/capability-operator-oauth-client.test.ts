import { describe, expect, test } from "bun:test";
import { findIntegrationsOauthClient, parseIntegrationsOauthClientsJson } from "@opengeni/config";
import {
  CapabilityCatalogItem,
  CapabilityCatalogResponse,
  type CapabilityCatalogItem as CatalogItem,
} from "@opengeni/contracts";
import { applyOperatorOAuthClientRequirement } from "../src";

function item(input: Partial<CatalogItem> = {}): CatalogItem {
  return CapabilityCatalogItem.parse({
    id: "registry:asana",
    name: "Asana",
    kind: "mcp",
    source: "registry",
    category: "project-management",
    runtime: { available: true, notes: null },
    metadata: {
      oauthClientRequirement: { issuer: "https://app.asana.com", reason: "no_self_registration" },
    },
    ...input,
  });
}

function resolver(json: string) {
  const configured = parseIntegrationsOauthClientsJson(json);
  return (issuer: string) => findIntegrationsOauthClient(configured, [issuer]) !== null;
}

describe("operator OAuth client connectability", () => {
  test("projects configured=false when the deployment has no client for the issuer", () => {
    const projected = applyOperatorOAuthClientRequirement(
      item(),
      resolver(JSON.stringify({ "https://accounts.google.com": { clientId: "google" } })),
    );
    expect(projected.runtime.operatorOAuthClient).toEqual({ configured: false });
    // The projection survives the public response contract.
    expect(
      CapabilityCatalogResponse.parse({ items: [projected], installations: [] }).items[0]?.runtime
        .operatorOAuthClient,
    ).toEqual({ configured: false });
  });

  test("matches the issuer key the OAuth start uses, ignoring a trailing slash", () => {
    for (const key of ["https://app.asana.com", "https://app.asana.com/"]) {
      expect(
        applyOperatorOAuthClientRequirement(
          item(),
          resolver(JSON.stringify({ [key]: { clientId: "asana" } })),
        ).runtime.operatorOAuthClient,
      ).toEqual({ configured: true });
    }
  });

  test("leaves rows without a requirement, and non-MCP rows, untouched", () => {
    const none = resolver("{}");
    const plain = item({ metadata: {} });
    expect(applyOperatorOAuthClientRequirement(plain, none)).toBe(plain);
    const api = item({ kind: "api" });
    expect(applyOperatorOAuthClientRequirement(api, none)).toBe(api);
  });
});
