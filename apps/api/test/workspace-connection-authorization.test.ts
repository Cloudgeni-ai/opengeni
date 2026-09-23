import { expect, test } from "bun:test";
import { withWorkspaceConnectionAuthorization } from "../src/workspace-tool-gateway";

const input = {
  workspaceId: "workspace",
  serverId: "service",
  destinationUrl: "https://mcp.example/tools",
  connectionRef: { connectionId: "connection", providerDomain: "mcp.example" },
};
const credential = () => ({
  status: "ok" as const,
  connectionId: "connection",
  providerDomain: "mcp.example",
  headers: { authorization: "Bearer synthetic" },
});

test("gateway rechecks caller before and after native resolution", async () => {
  let live = false;
  let resolutions = 0;
  const resolve = withWorkspaceConnectionAuthorization(
    async () => {
      resolutions++;
      live = false;
      return credential();
    },
    async () => {
      if (!live) throw new Error("revoked");
    },
  );
  await expect(resolve(input)).rejects.toThrow("revoked");
  expect(resolutions).toBe(0);
  live = true;
  await expect(resolve(input)).rejects.toThrow("revoked");
  expect(resolutions).toBe(1);
});

test("gateway physical use requires both live caller and native connection authority", async () => {
  let live = true;
  let nativeLive = true;
  let nativeChecks = 0;
  const resolve = withWorkspaceConnectionAuthorization(
    async () => ({
      ...credential(),
      authorizeProviderRequest: async () => {
        nativeChecks++;
        return nativeLive;
      },
    }),
    async () => {
      if (!live) throw new Error("revoked");
    },
  );
  const result = await resolve(input);
  if (result.status !== "ok") throw new Error("expected usable connection");
  expect(await result.authorizeProviderRequest?.()).toBe(true);
  nativeLive = false;
  expect(await result.authorizeProviderRequest?.()).toBe(false);
  nativeLive = true;
  live = false;
  expect(await result.authorizeProviderRequest?.()).toBe(false);
  expect(nativeChecks).toBe(2);
});

test("gateway preserves native reauthorization failures and unwrapped native guards", async () => {
  const denied = {
    status: "auth_needed" as const,
    reason: "refresh_failed" as const,
    connectionId: "connection",
    providerDomain: "mcp.example",
  };
  const native = async () => denied;
  expect(withWorkspaceConnectionAuthorization(native)).toBe(native);
  expect(await withWorkspaceConnectionAuthorization(native, async () => {})(input)).toBe(denied);
});
