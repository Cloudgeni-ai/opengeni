import { describe, expect, test } from "bun:test";
import {
  APP_SERVER_MAX_TOTAL_BYTES,
  AppServerBundle,
  AppServerFetchRequest,
  isAppServerEgressHost,
  isAppServerModulePath,
  type AppServerManifest,
} from "@opengeni/contracts";
import {
  AppServerError,
  appServerManifestOf,
  appServerOutboundFetch,
  appServerViewerMayUse,
  routeAppServerTool,
  type AppServerDeps,
} from "../src/app-server/service";
import { mintAppServerRunToken, verifyAppServerRunToken } from "../src/app-server/token";
import {
  asAppAutomation,
  memberMayUseSource,
  sourceOfSyncAction,
  toolDataReaderOf,
} from "../src/site-tool-data";
import type { SiteToolAccountInventory } from "../src/site-tool-routing";

const SECRET = ["{", "{secret:Shared/Weather/api key}}"].join("");
const OTHER_SECRET = ["{", "{secret:Shared/Other/key}}"].join("");

describe("app server bundle", () => {
  test("accepts ES module paths and public hosts only", () => {
    expect(isAppServerModulePath("index.js")).toBe(true);
    expect(isAppServerModulePath("lib/util.mjs")).toBe(true);
    expect(isAppServerModulePath("../escape.js")).toBe(false);
    expect(isAppServerModulePath("/abs.js")).toBe(false);
    expect(isAppServerEgressHost("api.linear.app")).toBe(true);
    expect(isAppServerEgressHost("localhost")).toBe(false);
    expect(isAppServerEgressHost("10.0.0.1")).toBe(false);
    expect(isAppServerEgressHost("API.example.com")).toBe(false);
  });

  test("needs main among the files, unique paths, and empty files remove the code", () => {
    expect(AppServerBundle.safeParse({ files: [] }).success).toBe(true);
    expect(
      AppServerBundle.safeParse({ main: "a.js", files: [{ path: "b.js", content: "" }] }).success,
    ).toBe(false);
    expect(
      AppServerBundle.safeParse({
        main: "a.js",
        files: [
          { path: "a.js", content: "" },
          { path: "a.js", content: "" },
        ],
      }).success,
    ).toBe(false);
    expect(
      AppServerBundle.safeParse({ main: "a.js", files: [{ path: "a.js", content: "" }] }).success,
    ).toBe(true);
    expect(appServerManifestOf({ files: [] })).toBeNull();
    // Secrets go only to listed hosts, so a bundle with secrets lists some.
    expect(
      AppServerBundle.safeParse({
        main: "a.js",
        files: [{ path: "a.js", content: "" }],
        secrets: [SECRET],
      }).success,
    ).toBe(false);
    expect(
      AppServerBundle.safeParse({
        main: "a.js",
        files: [{ path: "a.js", content: "" }],
        tools: ["linear/list_issues", "not a tool"],
      }).success,
    ).toBe(false);
  });

  test("freezes a manifest whose digest follows the code, hosts and secrets", () => {
    const base = {
      main: "index.js",
      files: [{ path: "index.js", content: "export default {}" }],
      egress: ["api.example.com"],
      secrets: [SECRET],
    };
    const one = appServerManifestOf(base)!;
    expect(one.manifest.files[0]!.sizeBytes).toBe(17);
    expect(appServerManifestOf(base)!.manifest.digest).toBe(one.manifest.digest);
    expect(appServerManifestOf({ ...base, egress: [] })!.manifest.digest).not.toBe(
      one.manifest.digest,
    );
    expect(appServerManifestOf({ ...base, secrets: [] })!.manifest.digest).not.toBe(
      one.manifest.digest,
    );
    const withTools = appServerManifestOf({ ...base, tools: ["linear/list_issues"] })!;
    expect(withTools.manifest.tools).toEqual(["linear/list_issues"]);
    expect(withTools.manifest.digest).not.toBe(one.manifest.digest);
    expect(() =>
      appServerManifestOf({
        main: "index.js",
        files: [{ path: "index.js", content: "x".repeat(APP_SERVER_MAX_TOTAL_BYTES + 1) }],
      }),
    ).toThrow(AppServerError);
  });

  test("page requests need a path starting with /", () => {
    expect(AppServerFetchRequest.safeParse({ path: "/issues?x=1" }).success).toBe(true);
    expect(AppServerFetchRequest.safeParse({ path: "https://evil.example/" }).success).toBe(false);
  });
});

describe("app server run token", () => {
  const claims = {
    runId: "11111111-1111-4111-8111-111111111111",
    accountId: "acct",
    workspaceId: "ws",
    siteId: "22222222-2222-4222-8222-222222222222",
    versionId: "33333333-3333-4333-8333-333333333333",
    expiresAt: Date.now() + 10_000,
  };

  test("verifies with the current or previous secret, until it expires", () => {
    const token = mintAppServerRunToken("old", claims);
    expect(verifyAppServerRunToken(["new", "old"], token)).toEqual(claims);
    expect(verifyAppServerRunToken(["new"], token)).toBeNull();
    expect(verifyAppServerRunToken(["old"], token, claims.expiresAt + 1)).toBeNull();
  });

  test("rejects a token whose claims were changed", () => {
    const token = mintAppServerRunToken("s", claims);
    const [, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify([
        claims.runId,
        claims.accountId,
        claims.workspaceId,
        "44444444-4444-4444-8444-444444444444",
        claims.versionId,
        claims.expiresAt,
      ]),
    ).toString("base64url");
    expect(verifyAppServerRunToken(["s"], `${forged}.${signature}`)).toBeNull();
    expect(verifyAppServerRunToken(["s"], `${token}.extra`)).toBeNull();
  });
});

describe("app server tool routing", () => {
  const inventory: SiteToolAccountInventory = {
    canonical: new Map([["linear", { name: "Linear" } as never]]),
    plain: new Set(["opengeni", "weather", "hosted", "catalog"]),
    accounts: [
      { serverId: "linear__mine", canonicalServerId: "linear", shared: false } as never,
      { serverId: "linear__team", canonicalServerId: "linear", shared: true } as never,
    ],
    servers: new Map([
      ["weather", { url: "https://weather.example/mcp" }],
      ["opengeni", {}],
      [
        "hosted",
        {
          url: "https://hosted.example/mcp",
          connectionRef: {
            authoritySource: "host",
            connectionId: "c1",
            providerDomain: "hosted.example",
            subjectScope: "subject",
          },
        },
      ],
      ["catalog", { url: "https://catalog.example/mcp" }],
    ]),
    capabilityServers: new Set(["catalog"]),
  };
  const declared = [
    { serverId: "linear", toolName: "list_issues" },
    { serverId: "weather", toolName: "forecast" },
    { serverId: "opengeni", toolName: "session_create" },
    { serverId: "hosted", toolName: "read" },
    { serverId: "catalog", toolName: "read" },
  ];
  const route = (serverId: string, toolName: string, from = inventory) =>
    routeAppServerTool(from, declared, { serverId, toolName });

  test("a connector tool runs on the workspace's shared account, never a personal one", () => {
    expect(route("linear", "list_issues")).toEqual({
      serverId: "linear__team",
      toolName: "list_issues",
    });
    expect(route("linear__mine", "list_issues")).toEqual({
      serverId: "linear__team",
      toolName: "list_issues",
    });
    expect(route("linear__team", "list_issues")).toEqual({
      serverId: "linear__team",
      toolName: "list_issues",
    });
  });

  test("without a shared account the call fails instead of using a person's", () => {
    const personalOnly = {
      ...inventory,
      accounts: inventory.accounts.filter((account) => account.shared !== true),
    };
    expect(() => route("linear", "list_issues", personalOnly)).toThrow(/shared/);
    expect(() => route("linear__mine", "list_issues", personalOnly)).toThrow(/shared/);
  });

  test("only declared tools, and never first-party tools that act as a person", () => {
    expect(() => route("linear", "delete_issue")).toThrow(/doesn't declare/);
    expect(() => route("opengeni", "session_create")).toThrow(/act as a person/);
    expect(route("weather", "forecast")).toEqual({ serverId: "weather", toolName: "forecast" });
    expect(() => route("unknown", "list_issues")).toThrow(AppServerError);
  });

  test("never a host-authority connection or a server enabled from the catalog", () => {
    // Either may carry a person's own credentials (the deployer's included).
    expect(() => route("hosted", "read")).toThrow(/act as a person/);
    expect(() => route("catalog", "read")).toThrow(/act as a person/);
    // Without the capability list the server is refused, not assumed workspace-wide.
    const { capabilityServers: _omitted, ...unknownOrigin } = inventory;
    expect(() => route("weather", "forecast", unknownOrigin)).toThrow(/act as a person/);
  });
});

describe("app server outbound fetch", () => {
  const manifest: AppServerManifest = {
    main: "index.js",
    files: [{ path: "index.js", sha256: "0".repeat(64), sizeBytes: 1 }],
    egress: ["api.example.com"],
    secrets: [SECRET],
    tools: [],
    digest: "0".repeat(64),
  };
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const deps = {
    settings: { environment: "test" },
    appServerOutboundFetch: async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response("ok", { status: 200, headers: { "set-cookie": "a=b" } });
    },
  } as unknown as AppServerDeps;
  const scope = { accountId: "acct", workspaceId: "ws" };
  const fetchWith = (input: Record<string, unknown>) =>
    appServerOutboundFetch(deps, scope, manifest, input);

  test("reaches listed hosts over https and drops cookies from the answer", async () => {
    const result = await fetchWith({ url: "https://api.example.com/v1?q=1", headers: [] });
    expect(result.status).toBe(200);
    expect(Buffer.from(result.bodyBase64, "base64").toString()).toBe("ok");
    expect(result.headers.some(([name]) => name === "set-cookie")).toBe(false);
    expect(sent.at(-1)?.init.redirect).toBe("manual");
  });

  test("refuses other hosts, plain http, ports and credentials in the URL", async () => {
    for (const url of [
      "https://other.example.com/",
      "http://api.example.com/",
      "https://api.example.com:8443/",
      "https://user:pass@api.example.com/",
    ])
      await expect(fetchWith({ url })).rejects.toThrow(AppServerError);
  });

  test("only listed secrets, and only in header values", async () => {
    await expect(
      fetchWith({ url: "https://api.example.com/", headers: [["authorization", OTHER_SECRET]] }),
    ).rejects.toThrow(/only use the vault secrets its version lists/);
    await expect(fetchWith({ url: `https://api.example.com/?key=${SECRET}` })).rejects.toThrow(
      /headers, not the URL/,
    );
    await expect(
      fetchWith({
        url: "https://api.example.com/",
        method: "POST",
        bodyBase64: Buffer.from(SECRET).toString("base64"),
      }),
    ).rejects.toThrow(/not the body/);
  });

  test("a secret goes out only for a viewer who may use it", async () => {
    const before = sent.length;
    const refused = await appServerOutboundFetch(
      deps,
      scope,
      manifest,
      { url: "https://api.example.com/", headers: [["authorization", SECRET]] },
      undefined,
      { mayUseSecrets: async () => false },
    ).catch((error: AppServerError) => error);
    expect(refused).toBeInstanceOf(AppServerError);
    expect((refused as AppServerError).details.reason).toBe("not_permitted");
    expect(sent.length).toBe(before);
  });
});

describe("app server viewer permission", () => {
  const viewer: SiteToolAccountInventory = {
    canonical: new Map([["linear", { name: "Linear" } as never]]),
    plain: new Set(["weather"]),
    accounts: [
      { serverId: "linear__team", canonicalServerId: "linear", shared: true } as never,
      { serverId: "linear__mine", canonicalServerId: "linear", shared: false } as never,
    ],
  };
  test("the viewer must reach the same shared account, or the account-less server", () => {
    expect(appServerViewerMayUse(viewer, { serverId: "linear__team", toolName: "x" })).toBe(true);
    expect(appServerViewerMayUse(viewer, { serverId: "weather", toolName: "x" })).toBe(true);
    // Their own account doesn't count, nor a shared account they can't reach.
    expect(appServerViewerMayUse(viewer, { serverId: "linear__mine", toolName: "x" })).toBe(false);
    expect(appServerViewerMayUse(viewer, { serverId: "linear__other", toolName: "x" })).toBe(false);
    expect(appServerViewerMayUse(viewer, { serverId: "linear", toolName: "x" })).toBe(false);
  });
});

describe("stored tool data", () => {
  const member = { permissions: ["workspace:read"], permissionMode: "exact" } as never;
  const inventory: SiteToolAccountInventory = {
    canonical: new Map([["linear", { name: "Linear" } as never]]),
    plain: new Set(["weather"]),
    accounts: [{ serverId: "linear__mine", canonicalServerId: "linear", shared: false } as never],
  };
  test("data from a shared account needs that same account; other data needs the connector", () => {
    const shared = { target: "sql", connector: "linear", route: "linear__team", shared: true };
    expect(memberMayUseSource(member, inventory, shared)).toBe(false);
    expect(
      memberMayUseSource(
        member,
        {
          ...inventory,
          accounts: [
            { serverId: "linear__team", canonicalServerId: "linear", shared: true } as never,
          ],
        },
        shared,
      ),
    ).toBe(true);
    const owners = { target: "sql", connector: "linear", route: "linear__owner", shared: false };
    expect(memberMayUseSource(member, inventory, owners)).toBe(true);
    expect(memberMayUseSource(member, { ...inventory, accounts: [] }, owners)).toBe(false);
    expect(
      memberMayUseSource(member, inventory, { ...owners, connector: "weather", route: "weather" }),
    ).toBe(true);
    expect(
      memberMayUseSource(member, inventory, { ...owners, connector: "vault", route: "vault" }),
    ).toBe(false);
  });
  test("a live shared sync counts from its definition", () => {
    expect(
      sourceOfSyncAction({
        kind: "app_sync",
        collection: "issues",
        mode: "shared",
        tool: { serverId: "linear__owner", toolName: "list_issues" },
        declaredTools: [
          { serverId: "linear__owner", toolName: "list_issues" },
          { serverId: "linear", toolName: "list_issues" },
        ],
        ownerAccount: null,
      }),
    ).toEqual({
      target: "collection:issues",
      connector: "linear",
      route: "linear__owner",
      shared: false,
    });
    expect(
      sourceOfSyncAction({
        collection: "rows",
        target: { table: "rows" },
        tool: { serverId: "linear", toolName: "list_issues" },
        declaredTools: [],
      })?.target,
    ).toBe("sql");
  });
  test("only accesses the API built for the app's automation read as the system", () => {
    // A scheduled agent session's principal looks like a sync's; it still reads as its person.
    const scheduled = { caller: { principal: "schedule:abc" }, subjectId: "user:1" };
    expect(toolDataReaderOf(scheduled)).toEqual({ subjectId: "user:1" });
    expect(toolDataReaderOf({ ...scheduled, subjectId: null })).toEqual({ subjectId: null });
    expect(toolDataReaderOf(asAppAutomation({ ...scheduled }))).toBe("system");
  });
});
