import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  allowlisted,
  decodeShape,
  diffSnapshots,
  encodeShape,
  extractSdkMethods,
  flattenJsonSchema,
  matchRoutes,
  moduleExports,
  normalizeSdkPath,
  validateAllowlist,
  type Snapshot,
} from "./surface";

function shapeOf(schema: z.ZodType, io: "input" | "output") {
  return encodeShape(
    flattenJsonSchema(
      z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Record<string, unknown>,
    ),
  );
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    schemaVersion: 1,
    generatedBy: "test",
    sdkMajor: 7,
    routes: [],
    ingress: [],
    unmatchedSdkCalls: [],
    events: {},
    schemas: {},
    exports: {},
    sdkMembers: {},
    ...overrides,
  };
}

const route = (method: string, path: string, request: string[] = [], response: string[] = []) => ({
  method,
  path,
  sdk: ["OpenGeniClient.x"],
  request,
  response,
});

function breakingIds(before: Snapshot, after: Snapshot): string[] {
  return diffSnapshots(before, after)
    .filter((finding) => finding.breaking)
    .map((finding) => finding.id);
}

describe("SDK path extraction", () => {
  test("normalizes template placeholders and strips query suffixes", () => {
    expect(normalizeSdkPath("/v1/workspaces/\0/sessions/\0")).toBe("/v1/workspaces/:p/sessions/:p");
    expect(normalizeSdkPath("/v1/workspaces/\0/files\0")).toBe("/v1/workspaces/:p/files");
    expect(normalizeSdkPath("/v1/")).toBeNull();
    expect(normalizeSdkPath("/v1/workspaces?limit=1")).toBe("/v1/workspaces");
    expect(normalizeSdkPath("/v1/\0")).toBeNull();
    expect(normalizeSdkPath("/healthz")).toBeNull();
  });

  test("prefers a parameter-aligned route over a literal the placeholder could name", () => {
    const registered = [
      { method: "GET", path: "/v1/workspaces/:workspaceId/sessions/:id" },
      { method: "GET", path: "/v1/workspaces/:workspaceId/sessions/drafts" },
      { method: "POST", path: "/v1/workspaces/:workspaceId/sessions/:id" },
    ];
    expect(matchRoutes("/v1/workspaces/:p/sessions/:p", "GET", registered)).toEqual([
      { method: "GET", path: "/v1/workspaces/:workspaceId/sessions/:id" },
    ]);
    expect(
      matchRoutes("/v1/workspaces/:p/:p/status", "GET", [
        { method: "GET", path: "/v1/workspaces/:workspaceId/codex/status" },
      ]),
    ).toHaveLength(1);
    expect(matchRoutes("/v1/workspaces/:p/missing", "GET", registered)).toEqual([]);
  });

  test("collects verbs, paths, helper prefixes, request/response types, and @internal", () => {
    const dir = mkdtempSync(join(tmpdir(), "public-api-sdk-"));
    const file = join(dir, "client.ts");
    writeFileSync(
      file,
      `function sessionRoot(workspaceId: string, sessionId: string) {
  return \`/v1/workspaces/\${workspaceId}/sessions/\${sessionId}\`;
}
export class Client {
  async getSession(workspaceId: string, sessionId: string): Promise<Session> {
    return this.requestJson<Session>("GET", sessionRoot(workspaceId, sessionId));
  }
  async getEvents(workspaceId: string, sessionId: string): Promise<SessionEvent[]> {
    return this.requestJson("GET", \`\${sessionRoot(workspaceId, sessionId)}/events\`);
  }
  opaqueHelper() {
    const sessionRoot = unknownHelper;
    return this.requestJson("GET", sessionRoot("workspace", "session"));
  }
  async createThing(workspaceId: string, request: CreateThingRequest): Promise<Thing> {
    return await this.requestJson<Thing>("POST", \`/v1/workspaces/\${workspaceId}/things\`, request);
  }
  transport() {
    const root = (id: string) => \`/v1/workspaces/\${id}/connect\`;
    return { catalog: (id: string) => this.requestJson("GET", \`\${root(id)}/catalog\`) };
  }
  /** Web app only. @internal */
  async secret(): Promise<void> {
    await this.requestJson("DELETE", "/v1/secret/thing");
  }
}`,
    );
    const methods = extractSdkMethods([file]);
    expect([...methods.find((method) => method.name === "Client.getSession")!.paths]).toEqual([
      "/v1/workspaces/:p/sessions/:p",
    ]);
    expect([...methods.find((method) => method.name === "Client.getEvents")!.paths]).toEqual([
      "/v1/workspaces/:p/sessions/:p/events",
    ]);
    expect(methods.some((method) => method.name === "Client.opaqueHelper")).toBe(false);
    const create = methods.find((method) => method.name === "Client.createThing")!;
    expect([...create.verbs]).toEqual(["POST"]);
    expect([...create.paths]).toEqual(["/v1/workspaces/:p/things"]);
    expect([...create.requestTypes]).toContain("CreateThingRequest");
    expect([...create.responseTypes]).toContain("Thing");
    const transport = methods.find((method) => method.name === "Client.transport")!;
    expect([...transport.paths]).toContain("/v1/workspaces/:p/connect/catalog");
    expect(methods.find((method) => method.name === "Client.secret")?.internal).toBe(true);
  });
});

describe("export surface", () => {
  test("follows re-exports transitively and keeps value vs type-only kinds", () => {
    const dir = mkdtempSync(join(tmpdir(), "public-api-exports-"));
    mkdirSync(join(dir, "nested"));
    writeFileSync(
      join(dir, "nested", "index.ts"),
      "export const value = 1;\nexport type Shape = { a: string };\nexport class Box {}\n",
    );
    writeFileSync(
      join(dir, "index.ts"),
      `export * from "./nested";
export { value as renamed } from "./nested";
export type { Box as BoxType } from "./nested";
import { Box } from "./nested";
export { Box as LocalBox };
export * from "@external/pkg";
`,
    );
    const exports = Object.fromEntries(moduleExports(join(dir, "index.ts")));
    expect(exports).toEqual({
      value: "value",
      Shape: "type",
      Box: "value",
      renamed: "value",
      BoxType: "type",
      LocalBox: "value",
      "* from @external/pkg": "value",
    });
  });
});

describe("schema compatibility rules", () => {
  const Request = z.object({ name: z.string(), mode: z.enum(["a", "b"]).optional() });
  const Response = z.object({
    id: z.string(),
    status: z.enum(["idle", "running"]),
    note: z.string().optional(),
  });

  function withSchemas(request: z.ZodType, response: z.ZodType): Snapshot {
    return snapshot({
      routes: [route("POST", "/v1/things", ["Req"], ["Res"])],
      schemas: {
        Req: { io: ["input"], shape: shapeOf(request, "input") },
        Res: { io: ["output"], shape: shapeOf(response, "output") },
      },
    });
  }

  test("shapes round-trip through the compact encoding", () => {
    const shape = flattenJsonSchema(
      z.toJSONSchema(Response, { io: "output" }) as Record<string, unknown>,
    );
    expect(decodeShape(encodeShape(shape))).toEqual(shape);
    expect(encodeShape(shape)["$.status"]).toBe('enum!=["\\"idle\\"","\\"running\\""]');
  });

  test("identical snapshots have no findings", () => {
    expect(diffSnapshots(withSchemas(Request, Response), withSchemas(Request, Response))).toEqual(
      [],
    );
  });

  test("additive changes are not breaking", () => {
    const before = withSchemas(Request, Response);
    const after = withSchemas(
      Request.extend({ extra: z.string().optional(), mode: z.enum(["a", "b", "c"]).optional() }),
      Response.extend({ added: z.number(), status: z.enum(["idle", "running", "paused"]) }),
    );
    const findings = diffSnapshots(before, after);
    expect(findings.filter((finding) => finding.breaking)).toEqual([]);
    expect(findings.map((finding) => finding.message)).toEqual(
      expect.arrayContaining([
        "Req $.extra: field added",
        "Res $.added: field added",
        'Res $.status: values added: "paused"',
      ]),
    );
  });

  test("new required request fields, narrowed request enums, and optional->required are breaking", () => {
    const before = withSchemas(Request, Response);
    expect(
      breakingIds(before, withSchemas(Request.extend({ must: z.string() }), Response)),
    ).toEqual(["schema:Req:$.must"]);
    expect(
      breakingIds(
        before,
        withSchemas(Request.extend({ mode: z.enum(["a"]).optional() }), Response),
      ),
    ).toEqual(["schema:Req:$.mode"]);
    expect(
      breakingIds(before, withSchemas(Request.extend({ mode: z.enum(["a", "b"]) }), Response)),
    ).toEqual(["schema:Req:$.mode"]);
  });

  test("removed, retyped, weakened, or newly nullable response fields are breaking", () => {
    const before = withSchemas(Request, Response);
    expect(breakingIds(before, withSchemas(Request, Response.omit({ note: true })))).toEqual([
      "schema:Res:$.note",
    ]);
    expect(breakingIds(before, withSchemas(Request, Response.extend({ id: z.number() })))).toEqual([
      "schema:Res:$.id",
    ]);
    expect(
      breakingIds(before, withSchemas(Request, Response.extend({ id: z.string().optional() }))),
    ).toEqual(["schema:Res:$.id"]);
    expect(
      breakingIds(before, withSchemas(Request, Response.extend({ id: z.string().nullable() }))),
    ).toEqual(["schema:Res:$.id"]);
  });

  test("a removed request union variant is breaking; a removed response variant is not", () => {
    const own = z.object({ kind: z.literal("own") });
    const none = z.object({ kind: z.literal("none") });
    const Union = z.discriminatedUnion("kind", [
      own,
      none,
      z.object({ kind: z.literal("shared"), groupId: z.string() }),
    ]);
    const Narrow = z.discriminatedUnion("kind", [own, none]);
    const before = withSchemas(z.object({ sandbox: Union }), Response);
    const after = withSchemas(z.object({ sandbox: Narrow }), Response);
    expect(breakingIds(before, after)).toEqual(["schema:Req:$.sandbox"]);
    const responseBefore = withSchemas(Request, z.object({ sandbox: Union }));
    const responseAfter = withSchemas(Request, z.object({ sandbox: Narrow }));
    expect(breakingIds(responseBefore, responseAfter)).toEqual([]);
  });

  test("a field moved to a differently named schema breaks only when that shape breaks", () => {
    const a = z.object({ kind: z.literal("a"), url: z.string() });
    const b = z.object({ kind: z.literal("b") });
    const c = z.object({ kind: z.literal("c"), text: z.string() });
    const source = shapeOf(z.discriminatedUnion("kind", [a, b]), "input");
    const request = (ref: string) => ({
      io: ["input" as const],
      shape: { $: "object", "$.source": `ref(${ref})` },
    });
    const before = snapshot({
      schemas: { Req: request("Source"), Source: { io: ["input"], shape: source } },
    });
    const widened = snapshot({
      schemas: {
        Req: request("SourceInput"),
        Source: { io: ["input"], shape: source },
        SourceInput: {
          io: ["input"],
          shape: shapeOf(z.discriminatedUnion("kind", [a, b, c]), "input"),
        },
      },
    });
    expect(breakingIds(before, widened)).toEqual([]);
    const narrowed = snapshot({
      schemas: {
        Req: request("SourceInput"),
        Source: { io: ["input"], shape: source },
        SourceInput: { io: ["input"], shape: shapeOf(z.discriminatedUnion("kind", [a]), "input") },
      },
    });
    expect(breakingIds(before, narrowed)).toEqual(["schema:Req:$.source"]);
  });
});

describe("surface-level rules", () => {
  test("route, ingress, event-type, export, and SDK member removals are breaking", () => {
    const before = snapshot({
      routes: [route("GET", "/v1/a"), route("GET", "/v1/b")],
      ingress: ["POST /v1/webhooks/automations/:endpointId"],
      events: { SessionEventType: ["turn.started", "user.message"] },
      exports: { "@opengeni/sdk": { OpenGeniClient: "value", Session: "type", helper: "value" } },
      sdkMembers: { OpenGeniClient: ["createSession", "sendMessage"] },
    });
    const after = snapshot({
      routes: [route("GET", "/v1/a"), route("GET", "/v1/c")],
      ingress: [],
      events: { SessionEventType: ["turn.started", "turn.new"] },
      exports: {
        "@opengeni/sdk": {
          OpenGeniClient: "value",
          Session: "type",
          helper: "type",
          added: "value",
        },
      },
      sdkMembers: { OpenGeniClient: ["createSession", "sendMessage2"] },
    });
    expect(breakingIds(before, after).sort()).toEqual(
      [
        "event:SessionEventType:user.message",
        "export:@opengeni/sdk:helper",
        "ingress:POST /v1/webhooks/automations/:endpointId",
        "member:OpenGeniClient.sendMessage",
        "route:GET /v1/b",
      ].sort(),
    );
    const additive = diffSnapshots(before, after)
      .filter((finding) => !finding.breaking)
      .map((finding) => finding.id);
    expect(additive).toEqual(
      expect.arrayContaining([
        "route:GET /v1/c",
        "event:SessionEventType:turn.new",
        "export:@opengeni/sdk:added",
      ]),
    );
  });
});

describe("breaking-change allowlist", () => {
  const entry = {
    ids: ["route:GET /v1/b", "schema:Res:*"],
    deprecation: ".changeset/remove-b.md",
    removedInMajor: 8,
    sunset: "2027-01-01",
    reason: "Replaced by /v1/c; announced in the 7.4 changelog.",
  };

  test("entries must reference a deprecation, a removal major, a sunset, and a reason", () => {
    expect(validateAllowlist([entry])).toHaveLength(1);
    expect(() => validateAllowlist([{ ...entry, deprecation: "trust me" }])).toThrow(/deprecation/);
    expect(() => validateAllowlist([{ ...entry, removedInMajor: "8" }])).toThrow(/removedInMajor/);
    expect(() => validateAllowlist([{ ...entry, sunset: "later" }])).toThrow(/sunset/);
    expect(() => validateAllowlist([{ ...entry, ids: [] }])).toThrow(/ids/);
    expect(() => validateAllowlist({})).toThrow(/array/);
  });

  test("matches exact ids and prefixes, only for a later major unless a security exception", () => {
    const [valid] = validateAllowlist([entry]);
    const finding = (id: string) => ({ id, breaking: true, message: id });
    expect(allowlisted(finding("route:GET /v1/b"), [valid!], 7)).toBe(valid!);
    expect(allowlisted(finding("schema:Res:$.id"), [valid!], 7)).toBe(valid!);
    expect(allowlisted(finding("route:GET /v1/z"), [valid!], 7)).toBeNull();
    expect(allowlisted(finding("route:GET /v1/b"), [valid!], 8)).toBeNull();
    const security = { ...valid!, removedInMajor: 7, securityException: true };
    expect(allowlisted(finding("route:GET /v1/b"), [security], 7)).toBe(security);
  });
});
