import { expect, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { type EditableArtifactApplicationPort } from "@opengeni/core";
import { type ArtifactCatalogCandidate } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { registerArtifactCatalogRoutes } from "../src/routes/artifact-catalog";
import { EditableArtifactApplicationError } from "../src/routes/editable-artifacts";

const SECRET = "artifact-catalog-route-test-secret";
const accountId = "10000000-0000-4000-8000-000000000001";
const workspaceId = "20000000-0000-4000-8000-000000000002";
const sessionId = "30000000-0000-4000-8000-000000000003";
const createdAt = "2026-08-01T00:00:00.000Z";

function candidate(
  id: string,
  kind: ArtifactCatalogCandidate["kind"] = "site",
  overrides: Partial<ArtifactCatalogCandidate> = {},
): ArtifactCatalogCandidate {
  return {
    id,
    kind,
    origin:
      kind === "site"
        ? "site"
        : kind === "image"
          ? "generated_image"
          : kind === "file"
            ? "sandbox_file"
            : "editable_artifact",
    title: "Report",
    status: "active",
    created_at: createdAt,
    updated_at: createdAt,
    source_session_id: sessionId,
    version_id: null,
    sort_key: "2026-08-01T00:00:00.000001",
    ...overrides,
  };
}

function fixture(
  pages: ArtifactCatalogCandidate[][],
  options: {
    read?: EditableArtifactApplicationPort["readArtifact"];
    privateSession?: boolean;
    absentSession?: boolean;
    agentAttempt?: Partial<Parameters<typeof signDelegatedAccessToken>[1]>;
    file?: Record<string, unknown>;
    image?: Record<string, unknown>;
    pinUnavailable?: boolean;
  } = {},
) {
  const reads: Array<Parameters<EditableArtifactApplicationPort["readArtifact"]>[0]> = [];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const selectedTables: string[] = [];
  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    execute: async (query: SQL) => {
      const compiled = new PgDialect().sqlToQuery(query);
      queries.push(compiled);
      if (compiled.sql.includes("opengeni_private.update_artifact_pin(")) {
        if (options.pinUnavailable)
          throw Object.assign(new Error("target unavailable"), { code: "42501" });
        return [];
      }
      if (compiled.sql.includes("WITH candidates AS")) return pages.shift() ?? [];
      if (
        compiled.sql.includes("current_setting('opengeni.account_id'") ||
        compiled.sql.includes("current_setting('opengeni.subject_id'")
      )
        return [
          {
            account_id: accountId,
            workspace_id: workspaceId,
            subject_id: "user:catalog",
            private_file_owner: "",
            initiating_human_subject_id: "",
            personal_resource_human_subject_id: "",
            personal_resource_actor_subject_id: "",
          },
        ];
      if (compiled.sql.includes('session.root_session_id as "rootSessionId"')) return [];
      if (
        compiled.sql.includes("set_config") ||
        compiled.sql.includes("pg_advisory_xact_lock_shared")
      )
        return [];
      throw new Error(`Unexpected catalog database operation: ${compiled.sql.slice(0, 160)}`);
    },
    select: (fields?: Record<string, unknown>) => {
      let tableName = "";
      const builder = {
        from: (table: unknown) => {
          tableName = getTableName(table as never);
          selectedTables.push(tableName);
          return builder;
        },
        where: () => builder,
        innerJoin: () => builder,
        leftJoin: () => builder,
        then: (resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) =>
          Promise.resolve(tableName === "files" && options.file ? [options.file] : []).then(
            resolve,
            reject,
          ),
        limit: async () => {
          if (tableName === "workspaces") return [{ accountId }];
          if (tableName === "generated_image_artifacts")
            return options.image && options.file
              ? [{ artifact: options.image, file: options.file, uploadStatus: "uploaded" }]
              : [];
          if (tableName === "sessions" && options.absentSession) return [];
          if (tableName === "sessions" && fields)
            return [
              {
                sessionId,
                rootSessionId: sessionId,
                visibility: options.privateSession ? "user_private" : "workspace_shared",
                ownerSubjectId: options.privateSession ? "user:someone-else" : null,
              },
            ];
          if (tableName === "sessions") return [];
          if (tableName === "session_turn_attempts") return [];
          throw new Error("Unexpected catalog select");
        },
      };
      return builder;
    },
  };
  const app = new Hono();
  app.onError((error, context) => {
    if ("status" in error && typeof error.status === "number")
      return context.json({ message: error.message }, error.status as never);
    return context.json({ message: error.message }, 500);
  });
  registerArtifactCatalogRoutes(app, {
    db,
    settings: testSettings({ productAccessMode: "managed", delegationSecret: SECRET }),
    managedAuth: null,
    ...(options.read
      ? {
          editableArtifacts: {
            readArtifact: async (
              input: Parameters<EditableArtifactApplicationPort["readArtifact"]>[0],
            ) => {
              reads.push(input);
              return options.read!(input);
            },
          },
        }
      : {}),
  } as never);
  const request = async (
    query = "",
    permissions: Permission[] = ["artifacts:read"],
    subjectId = "user:catalog",
  ) =>
    app.request(`/v1/workspaces/${workspaceId}/artifact-catalog${query ? `?${query}` : ""}`, {
      headers: {
        authorization: `Bearer ${await signDelegatedAccessToken(SECRET, { accountId, workspaceId, subjectId, principalKind: "human_session", permissions, exp: Math.floor(Date.now() / 1000) + 3600, ...options.agentAttempt })}`,
      },
    });
  const pin = async (
    kind: string,
    id: string,
    body: unknown = { pinned: true },
    permissions: Permission[] = ["artifacts:publish", "artifacts:read"],
  ) =>
    app.request(`/v1/workspaces/${workspaceId}/artifact-catalog/${kind}/${id}/pin`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await signDelegatedAccessToken(SECRET, { accountId, workspaceId, subjectId: "user:catalog", principalKind: "human_session", permissions, exp: Math.floor(Date.now() / 1000) + 3600 })}`,
      },
      body: JSON.stringify(body),
    });
  return { app, request, pin, reads, queries, selectedTables };
}

test("pin mutations require publish plus target-domain read authority and validate closed input", async () => {
  const target = "40000000-0000-4000-8000-000000000004";
  const { pin, queries } = fixture([]);
  expect((await pin("site", target, { pinned: true }, ["artifacts:read"])).status).toBe(403);
  expect((await pin("site", target, { pinned: true }, ["artifacts:publish"])).status).toBe(403);
  expect(
    (await pin("file", target, { pinned: true }, ["artifacts:publish", "artifacts:read"])).status,
  ).toBe(403);
  for (const [kind, id, body] of [
    ["attachment", target, { pinned: true }],
    ["site", "bad", { pinned: true }],
    ["document", target, { pinned: true }],
    ["site", target, {}],
    ["site", target, { pinned: "true" }],
    ["site", target, { pinned: true, extra: true }],
  ] as const)
    expect((await pin(kind, id, body)).status).toBe(422);
  expect(queries.some(({ sql }) => sql.includes("update_artifact_pin("))).toBe(false);
});

test("pin/unpin returns compact state and maps scoped missing/foreign/hidden targets to 404", async () => {
  const target = "40000000-0000-4000-8000-000000000004";
  const visible = fixture([]);
  for (const pinned of [true, true, false, false]) {
    const response = await visible.pin("site", target, { pinned });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ kind: "site", artifactId: target, pinned });
  }
  const absent = fixture([], { pinUnavailable: true });
  expect((await absent.pin("site", target)).status).toBe(404);
  const file = fixture([]);
  expect(
    (await file.pin("file", target, { pinned: false }, ["artifacts:publish", "files:read"])).status,
  ).toBe(404);
  expect(file.queries.some(({ sql }) => sql.includes("update_artifact_pin("))).toBe(false);
});

test("editable pins use the non-mutating application read and never bypass denied or mismatched metadata", async () => {
  const target = "1".repeat(32);
  for (const code of ["not_found", "forbidden"] as const) {
    const denied = fixture([], {
      read: async () => {
        throw new EditableArtifactApplicationError(code);
      },
    });
    expect((await denied.pin("document", target)).status).toBe(404);
    expect(denied.reads).toHaveLength(1);
    expect(denied.queries.some(({ sql }) => sql.includes("update_artifact_pin("))).toBe(false);
  }
  const metadata = {
    id: target,
    modality: "document",
    scope: { accountId, workspaceId },
    title: "Report",
    lifecycle: "active",
    createdAt,
    updatedAt: createdAt,
  };
  const visible = fixture([], { read: async () => metadata as never });
  expect((await visible.pin("document", target)).status).toBe(200);
  expect(visible.reads[0]!.artifactId).toBe(target);
  const wrongKind = fixture([], {
    read: async () => ({ ...metadata, modality: "spreadsheet" }) as never,
  });
  expect((await wrongKind.pin("document", target)).status).toBe(404);
  const foreign = fixture([], {
    read: async () => ({ ...metadata, scope: { accountId, workspaceId: "foreign" } }) as never,
  });
  expect((await foreign.pin("document", target)).status).toBe(404);
});

test("file and image pin responses stay metadata-only and need files read, not artifacts read", async () => {
  const target = "40000000-0000-4000-8000-000000000004";
  for (const kind of ["file", "image"] as const) {
    const visible = fixture([], {
      file: {
        id: target,
        accountId,
        workspaceId,
        status: "ready",
        createdAt: new Date(createdAt),
        updatedAt: new Date(createdAt),
      },
    });
    const response = await visible.pin(kind, target.toUpperCase(), { pinned: true }, [
      "artifacts:publish",
      "files:read",
    ]);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ kind, artifactId: target, pinned: true });
    expect(visible.selectedTables).toEqual(["files"]);
  }
});

test("catalog projection and encrypted frontiers retain pins across the global pin boundary", async () => {
  const first = candidate("pinned-one", "site", { pinned: true, title: "Z", sort_key: "z" });
  const second = candidate("pinned-two", "site", { pinned: true, title: "ZZ", sort_key: "zz" });
  const third = candidate("unpinned-one", "site", { pinned: false, title: "A", sort_key: "a" });
  const fourth = candidate("unpinned-two", "site", { pinned: false, title: "B", sort_key: "b" });
  const { request, queries } = fixture([
    [first, second, third],
    [second, third],
    [third, fourth],
    [fourth],
  ]);
  let cursor: string | null = null;
  const items: Array<{ id: string; pinned: boolean }> = [];
  do {
    const response = await request(
      `sort=title&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const page = await response.json();
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  expect(items.map(({ id, pinned }) => ({ id, pinned }))).toEqual([
    { id: first.id, pinned: true },
    { id: second.id, pinned: true },
    { id: third.id, pinned: false },
    { id: fourth.id, pinned: false },
  ]);
  const statements = queries.filter(({ sql }) => sql.includes("WITH candidates AS"));
  expect(statements[1]!.params).toContain(true);
  expect(statements[2]!.params).toContain(true);
  expect(statements[3]!.params).toContain(false);
});

test("catalog is read-only and redacts unauthorized provenance before projection", async () => {
  const { request, queries } = fixture([[candidate("site-one")]]);
  const response = await request();
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({
    items: [
      {
        id: "site-one",
        kind: "site",
        title: "Report",
        status: "active",
        createdAt,
        updatedAt: createdAt,
      },
    ],
    nextCursor: null,
  });
  const query = queries.find((entry) => entry.sql.includes("WITH candidates AS"))!;
  expect(query.sql).toContain("workspace_artifacts");
  expect(query.sql).not.toContain("generated_image_artifacts");
  expect(query.sql).not.toContain("sandbox_file_publications");
  expect(query.sql).not.toContain("editable_artifacts");
  expect(queries.every(({ sql }) => !/\b(insert|update|delete)\b/i.test(sql))).toBe(true);
});

test("catalog validates filters and requires one domain's read authority", async () => {
  const { request } = fixture([]);
  expect((await request("", ["sessions:read"])).status).toBe(403);
  for (const query of [
    "limit=0",
    "limit=101",
    "sort=random",
    "status=deleted",
    "kind=attachment",
    "sourceSessionId=bad",
    "q=" + "x".repeat(201),
  ])
    expect((await request(query)).status).toBe(422);
  expect((await request(`sourceSessionId=${sessionId}`)).status).toBe(404);
  expect((await request("kind=document")).status).toBe(503);
});

test("authorized source filtering uses session authorization; private source filtering is denied", async () => {
  const allowed = fixture([[candidate("site-one")]]);
  const response = await allowed.request(`sourceSessionId=${sessionId}`, [
    "artifacts:read",
    "sessions:read",
  ]);
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await response.json()).items[0].sourceSessionId).toBe(sessionId);
  const denied = fixture([], { privateSession: true });
  expect(
    (await denied.request(`sourceSessionId=${sessionId}`, ["artifacts:read", "sessions:read"]))
      .status,
  ).toBe(404);
  expect(denied.queries.some(({ sql }) => sql.includes("WITH candidates AS"))).toBe(false);
});

test("RLS-hidden or missing source rows are never readable through the optional-host null fallback", async () => {
  const visibleArtifact = fixture([[candidate("shared-site")]], { absentSession: true });
  const response = await visibleArtifact.request("", ["artifacts:read", "sessions:read"]);
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json();
  expect(body.items[0].id).toBe("shared-site");
  expect(body.items[0].sourceSessionId).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain(sessionId);
  const filtered = fixture([], { absentSession: true });
  expect(
    (await filtered.request(`sourceSessionId=${sessionId}`, ["artifacts:read", "sessions:read"]))
      .status,
  ).toBe(404);
  expect(filtered.queries.some(({ sql }) => sql.includes("WITH candidates AS"))).toBe(false);
});

test.each(["site", "document", "spreadsheet", "presentation"] as const)(
  "%s-only discovery still verifies the exact agent attempt without files permission",
  async (kind) => {
    const { request, reads, queries } = fixture([], {
      read: async () => {
        throw new Error("A stale attempt must never reach the artifact application");
      },
      agentAttempt: {
        principalKind: "agent_attempt",
        sessionId,
        turnId: "40000000-0000-4000-8000-000000000004",
        attemptId: "50000000-0000-4000-8000-000000000005",
        executionGeneration: 1,
      },
    });
    const response = await request(`kind=${kind}`, ["artifacts:read", "sessions:read"]);
    expect(response.status, await response.clone().text()).toBe(404);
    expect(reads).toHaveLength(0);
    expect(queries.some(({ sql }) => sql.includes("WITH candidates AS"))).toBe(false);
  },
);

test("every editable candidate passes the injected non-mutating application, with denied rows skipped", async () => {
  const deniedId = "1".repeat(32);
  const allowedId = "2".repeat(32);
  const { request, reads } = fixture(
    [[candidate(deniedId, "document"), candidate(allowedId, "document")]],
    {
      read: async (input) => {
        if (input.artifactId === deniedId) throw new EditableArtifactApplicationError("forbidden");
        return {
          scope: input.scope,
          id: input.artifactId,
          modality: "document",
          title: "Authorized report",
          lifecycle: "active",
          createdAt,
          updatedAt: createdAt,
        } as never;
      },
    },
  );
  const response = await request("kind=document");
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await response.json()).items.map((item: { id: string }) => item.id)).toEqual([allowedId]);
  expect(reads.map((read) => read.artifactId)).toEqual([deniedId, allowedId]);
  expect(reads.every((read) => read.actor.kind === "human" && !("sessionId" in read.actor))).toBe(
    true,
  );
});

test("application cross-tenant metadata and unavailability fail closed", async () => {
  for (const read of [
    async () => {
      throw new EditableArtifactApplicationError("unavailable");
    },
    async () => ({
      scope: { accountId, workspaceId: "wrong-workspace" },
      id: "1".repeat(32),
      modality: "document",
      title: "Secret",
    }),
  ]) {
    const { request } = fixture([[candidate("1".repeat(32), "document")]], { read: read as never });
    const response = await request("kind=document");
    expect([500, 503]).toContain(response.status);
    expect(await response.text()).not.toContain("Secret");
  }
});

test("pagination uses precise stable tuple and rejects filter/principal cursor replay", async () => {
  const first = candidate("site-a"),
    second = candidate("site-b");
  const { request, queries } = fixture([[first, second], [second]]);
  const response = await request("limit=1");
  expect(response.status, await response.clone().text()).toBe(200);
  const page = await response.json();
  expect(page.items.map((item: { id: string }) => item.id)).toEqual(["site-a"]);
  expect(typeof page.nextCursor).toBe("string");
  const cursor = encodeURIComponent(page.nextCursor);
  expect((await request(`limit=1&q=other&cursor=${cursor}`)).status).toBe(422);
  expect((await request(`limit=1&cursor=${cursor}`, ["artifacts:read"], "user:other")).status).toBe(
    422,
  );
  const next = await request(`limit=1&cursor=${cursor}`);
  expect(await next.json()).toMatchObject({ items: [{ id: "site-b" }], nextCursor: null });
  const statement = queries.filter(({ sql }) => sql.includes("WITH candidates AS"))[1]!;
  expect(statement.params).toContain(first.sort_key);
  expect(statement.params).toContain(first.id);
  expect(statement.sql).toContain('kind COLLATE "C", id COLLATE "C"');
});

test("generated images and explicit files use retained references, never storage URLs or private provenance", async () => {
  const id = "40000000-0000-4000-8000-000000000004";
  const file = {
    id,
    accountId,
    workspaceId,
    filename: "report.png",
    safeFilename: "report.png",
    status: "ready",
    contentType: "image/png",
    sizeBytes: 10,
    sha256: "a".repeat(64),
    bucket: "private-bucket",
    objectKey: "private-object-key",
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
  const image = {
    artifactId: id,
    accountId,
    workspaceId,
    sessionId,
    status: "ready",
    sourceStrategy: "provider_adapter",
    providerId: "private-provider",
    providerBindingHash: "private-binding",
    width: 32,
    height: 32,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
  for (const kind of ["image", "file"] as const) {
    const { request, queries } = fixture([[candidate(id, kind)]], { file, image });
    const response = await request(`kind=${kind}`, ["files:read"]);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json();
    expect(body.items[0].file).toMatchObject({
      available: true,
      artifactId: id,
      kind: kind === "image" ? "generated_image" : "file",
      retrieval: { path: `/v1/workspaces/${workspaceId}/artifacts/${id}/content` },
    });
    if (kind === "image") expect(body.items[0].file.dimensions).toEqual({ width: 32, height: 32 });
    const serialized = JSON.stringify(body);
    for (const hidden of [
      "private-bucket",
      "private-object-key",
      "private-provider",
      "private-binding",
      sessionId,
      "https://",
    ])
      expect(serialized).not.toContain(hidden);
    expect(queries.find(({ sql }) => sql.includes("WITH candidates AS"))!.sql).not.toContain(
      "workspace_artifacts",
    );
  }
  for (const contentType of [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/svg+xml",
  ]) {
    const published = fixture([[candidate(id, "image", { origin: "sandbox_file" })]], {
      file: { ...file, contentType },
    });
    const response = await published.request("kind=image", ["files:read"]);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json();
    expect(body.items[0]).toMatchObject({
      id,
      kind: "image",
      file: { artifactId: id, kind: "file", contentType },
    });
    expect(body.items[0].file.dimensions).toBeUndefined();
    expect(body.items[0].origin).toBeUndefined();
    expect(published.selectedTables).not.toContain("generated_image_artifacts");
    expect(
      published.queries
        .find(({ sql }) => sql.includes("WITH candidates AS"))!
        .params.some((param) => typeof param === "string" && param.includes('"kinds":["image"]')),
    ).toBe(true);
  }
  const absent = fixture([[candidate(id, "file")]]);
  expect(await (await absent.request("kind=file", ["files:read"])).json()).toEqual({
    items: [],
    nextCursor: null,
  });
});
