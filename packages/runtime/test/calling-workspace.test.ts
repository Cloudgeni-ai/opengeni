import { describe, expect, test } from "bun:test";
import {
  OPENGENI_CALLING_WORKSPACE_HEADER,
  verifyCallingWorkspaceProof,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";

import {
  CallingWorkspaceProofUnavailableError,
  withCallingWorkspaceProof,
} from "../src/calling-workspace";

/* A workspace agent calling Opengeni's own MCP endpoints as a remote MCP
   server always names its workspace in a signed header, and sends nothing it
   can't sign; any other server never sees the header. */

const secret = "calling-workspace-test-delegation-secret";
const caller = { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: secret,
  publicBaseUrl: "https://opengeni.example",
  opengeniMcpUrl: "https://mcp.opengeni.example/v1/workspaces/{workspaceId}/mcp",
});

function header(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get(OPENGENI_CALLING_WORKSPACE_HEADER);
}

describe("calling-workspace header on remote MCP requests", () => {
  test("Opengeni's own hosts get the signed calling workspace, replacing a configured one", async () => {
    for (const url of [
      "https://opengeni.example/v1/mcp",
      "https://OPENGENI.example/v1/workspaces/w/mcp",
      "https://mcp.opengeni.example/v1/mcp",
      // However the host is spelled.
      "https://opengeni.example./v1/mcp",
      "https://opengeni.example../v1/mcp",
      "https://opengeni%2Eexample/v1/mcp",
      "https://opengeni%2eexample./v1/mcp",
      "https://opengeni.example:443/v1/mcp",
    ]) {
      const init = await withCallingWorkspaceProof(settings, caller, url, {
        headers: { authorization: "Bearer key", [OPENGENI_CALLING_WORKSPACE_HEADER]: "forged" },
      });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer key");
      expect(await verifyCallingWorkspaceProof(secret, header(init)!)).toEqual(caller);
    }
    // A Request input keeps its own headers.
    const request = new Request("https://opengeni.example/v1/mcp", {
      method: "POST",
      headers: { authorization: "Bearer key" },
    });
    const fromRequest = await withCallingWorkspaceProof(settings, caller, request, undefined);
    expect(new Headers(fromRequest?.headers).get("authorization")).toBe("Bearer key");
    expect(await verifyCallingWorkspaceProof(secret, header(fromRequest)!)).toEqual(caller);
  });

  test("a request carrying an Opengeni key or MCP token is Opengeni, on any host", async () => {
    const proxied = "https://proxy.example.com/v1/mcp";
    for (const credential of [
      "Bearer ogp_personalkey12345",
      "Bearer ogk_organizationkey123",
      "Bearer ogmcp_at_accesstoken12345",
    ]) {
      const init = await withCallingWorkspaceProof(settings, caller, proxied, {
        headers: { authorization: credential },
      });
      expect(await verifyCallingWorkspaceProof(secret, header(init)!), credential).toEqual(caller);
    }
    const inQuery = await withCallingWorkspaceProof(
      settings,
      caller,
      `${proxied}?key=ogk_organizationkey123`,
      undefined,
    );
    expect(await verifyCallingWorkspaceProof(secret, header(inQuery)!)).toEqual(caller);
    // A key it can't sign for sends nothing.
    await expect(
      withCallingWorkspaceProof(settings, {}, proxied, {
        headers: { "x-api-key": "ogp_personalkey12345" },
      }),
    ).rejects.toBeInstanceOf(CallingWorkspaceProofUnavailableError);
  });

  test("any other host never sees it", async () => {
    const init = { headers: { authorization: "Bearer key", "x-note": "dogp_" } };
    for (const url of [
      "https://mcp.example.com/v1/mcp",
      "https://opengeni.example.evil.test/v1/mcp",
      "https://opengeni.example:8443/v1/mcp",
      "https://notopengeni.example/v1/mcp",
    ]) {
      expect(await withCallingWorkspaceProof(settings, caller, url, init)).toBe(init);
    }
  });

  test("nothing is sent to Opengeni itself when the header can't be signed", async () => {
    const url = "https://opengeni.example/v1/mcp";
    await expect(withCallingWorkspaceProof(settings, {}, url, undefined)).rejects.toBeInstanceOf(
      CallingWorkspaceProofUnavailableError,
    );
    const unsigned = { ...settings, delegationSecret: undefined };
    await expect(
      withCallingWorkspaceProof(unsigned, caller, url, undefined),
    ).rejects.toBeInstanceOf(CallingWorkspaceProofUnavailableError);
  });

  test("a forged, altered or expired proof names no workspace", async () => {
    const init = await withCallingWorkspaceProof(
      settings,
      caller,
      "https://opengeni.example/v1/mcp",
      undefined,
    );
    const proof = header(init)!;
    expect(await verifyCallingWorkspaceProof("another-secret", proof)).toBeNull();
    expect(await verifyCallingWorkspaceProof(secret, `${proof}x`)).toBeNull();
    expect(await verifyCallingWorkspaceProof(secret, proof.replace("ogcw_", "ogd_"))).toBeNull();
    const later = Math.floor(Date.now() / 1000) + 3_600;
    expect(await verifyCallingWorkspaceProof(secret, proof, later)).toBeNull();
  });
});
