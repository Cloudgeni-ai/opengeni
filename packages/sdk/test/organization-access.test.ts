import { describe, expect, test } from "bun:test";
import {
  AccessCredential as ContractAccessCredential,
  AccessGrant as ContractAccessGrant,
  ApiKey as ContractApiKey,
  CreateOrganizationApiKeyRequest as ContractCreateRequest,
  OrganizationAccessPolicy as ContractPolicy,
  OrganizationAccessPreset as ContractPreset,
  OrganizationActor as ContractActor,
  OrganizationWorkspaceScope as ContractScope,
  UpdateOrganizationApiKeyRequest as ContractUpdateRequest,
  organizationAccessPresetPermissions,
} from "@opengeni/contracts";
import type { z } from "zod";
import {
  KNOWN_PERMISSIONS,
  OpenGeniClient,
  type AccessCredential,
  type AccessGrant,
  type ApiKey,
  type CreateOrganizationApiKeyRequest,
  type KnownPermission,
  type OrganizationAccessPolicy,
  type OrganizationAccessPreset,
  type OrganizationActor,
  type OrganizationWorkspaceScope,
  type UpdateOrganizationApiKeyRequest,
} from "../src/index";
import { OpenGeniCoreClient } from "../src/core";
import { OpenGeniClient as OpenGeniArtifactClient } from "../src/artifacts";
import { OpenGeniDocumentAuthorityClient } from "../src/document-authority";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const KEY_ID = "33333333-3333-4333-8333-333333333333";
const keyPath = `/v1/organizations/${ORGANIZATION_ID}/api-keys/${KEY_ID}`;

const policy = {
  preset: "custom",
  permissions: ["workspace:read", "sessions:read"],
  workspaceScope: { kind: "selected", workspaceIds: [WORKSPACE_ID] },
} satisfies OrganizationAccessPolicy;

function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: KEY_ID,
    accountId: ORGANIZATION_ID,
    workspaceId: null,
    name: "Reporting",
    description: null,
    prefix: "ogk_example",
    permissions: policy.permissions,
    policy,
    workspaceScope: policy.workspaceScope,
    permissionMode: "explicit",
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: "2026-10-02T17:00:00Z",
    updatedAt: "2026-10-02T17:00:00Z",
    ...overrides,
  };
}

function makeClient(respond: (request: Request) => Response, Client: typeof OpenGeniCoreClient) {
  const requests: Request[] = [];
  const client = new Client({
    baseUrl: "https://api.example.test",
    apiKey: "ogk_fixture",
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return respond(request);
    }) as typeof fetch,
  });
  return { client, requests };
}

describe.each([
  ["root", OpenGeniClient],
  ["core", OpenGeniCoreClient],
  ["artifacts", OpenGeniArtifactClient],
  ["document-authority", OpenGeniDocumentAuthorityClient],
] as const)("organization API-key requests (%s)", (_entry, Client) => {
  test("GET detail returns the raw key and policy, never a token wrapper", async () => {
    const key = apiKey();
    const { client, requests } = makeClient(() => Response.json(key), Client);
    const result: ApiKey = await client.getOrganizationApiKey(ORGANIZATION_ID, KEY_ID);
    expect(result).toEqual(key);
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("apiKey");
    expect(requests[0]!.method).toBe("GET");
    expect(new URL(requests[0]!.url).pathname).toBe(keyPath);
    expect(requests[0]!.body).toBeNull();
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer ogk_fixture");
  });

  test.each(["read_only", "full", "custom"] as const)(
    "create forwards the explicit %s policy without expanding its label",
    async (preset) => {
      const requestedPolicy: OrganizationAccessPolicy = { ...policy, preset };
      const { client, requests } = makeClient(
        () => Response.json({ apiKey: apiKey(), token: "ogk_once" }, { status: 201 }),
        Client,
      );
      const input: CreateOrganizationApiKeyRequest = {
        name: "Policy key",
        policy: requestedPolicy,
      };
      const result = await client.createOrganizationApiKey(ORGANIZATION_ID, input);
      expect(result).toEqual({ apiKey: apiKey(), token: "ogk_once" });
      expect(requests[0]!.method).toBe("POST");
      expect(new URL(requests[0]!.url).pathname).toBe(keyPath.replace(`/${KEY_ID}`, ""));
      expect(await requests[0]!.json()).toEqual(input);
    },
  );

  test.each([
    { name: "Renamed" },
    { description: "New description" },
    { description: null },
    { policy },
    { policy: { ...policy, workspaceScope: { kind: "all" } } },
    { name: "Renamed", description: null, policy },
  ] satisfies UpdateOrganizationApiKeyRequest[])(
    "PATCH preserves exactly the supplied changes: %j",
    async (input) => {
      const key = apiKey();
      const { client, requests } = makeClient(() => Response.json(key), Client);
      const result: ApiKey = await client.updateOrganizationApiKey(ORGANIZATION_ID, KEY_ID, input);
      expect(result).toEqual(key);
      expect(result).not.toHaveProperty("token");
      expect(result).not.toHaveProperty("apiKey");
      expect(requests[0]!.method).toBe("PATCH");
      expect(new URL(requests[0]!.url).pathname).toBe(keyPath);
      expect(await requests[0]!.json()).toEqual(input);
    },
  );

  test("name-only PATCH preserves the server's legacy projection", async () => {
    const key = apiKey({
      name: "Renamed legacy key",
      permissions: ["workspace:admin"],
      permissionMode: "legacy",
      policy: undefined,
      workspaceScope: { kind: "all" },
      access: "full",
    });
    const { client, requests } = makeClient(() => Response.json(key), Client);
    const result = await client.updateOrganizationApiKey(ORGANIZATION_ID, KEY_ID, {
      name: key.name,
    });
    expect(result.permissions).toEqual(["workspace:admin"]);
    expect(result.permissionMode).toBe("legacy");
    expect(result.policy).toBeUndefined();
    expect(await requests[0]!.json()).toEqual({ name: key.name });
  });

  test("PATCH preserves explicit empty permissions and selected workspace IDs", async () => {
    const emptyPolicy: OrganizationAccessPolicy = {
      preset: "custom",
      permissions: [],
      workspaceScope: { kind: "selected", workspaceIds: [] },
    };
    const key = apiKey({
      permissions: [],
      policy: emptyPolicy,
      workspaceScope: emptyPolicy.workspaceScope,
    });
    const { client, requests } = makeClient(() => Response.json(key), Client);

    const result = await client.updateOrganizationApiKey(ORGANIZATION_ID, KEY_ID, {
      policy: emptyPolicy,
    });

    expect(result).toEqual(key);
    expect(await requests[0]!.json()).toEqual({ policy: emptyPolicy });
    expect(requests).toHaveLength(1);
  });

  test("a 409 PATCH conflict is surfaced without an automatic retry", async () => {
    const { client, requests } = makeClient(
      () => Response.json({ error: "Organization key policy conflict" }, { status: 409 }),
      Client,
    );

    await expect(
      client.updateOrganizationApiKey(ORGANIZATION_ID, KEY_ID, { policy }),
    ).rejects.toMatchObject({ status: 409, outcomeUnknown: false });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("PATCH");
    expect(new URL(requests[0]!.url).pathname).toBe(keyPath);
    expect(await requests[0]!.json()).toEqual({ policy });
  });

  test("an uncertain PATCH is not replayed", async () => {
    let requests = 0;
    const client = new Client({
      baseUrl: "https://api.example.test",
      fetch: (async () => {
        requests += 1;
        throw new Error("Connection interrupted");
      }) as unknown as typeof fetch,
    });
    await expect(
      client.updateOrganizationApiKey(ORGANIZATION_ID, KEY_ID, { policy }),
    ).rejects.toMatchObject({ outcomeUnknown: true });
    expect(requests).toBe(1);
  });
});

describe("organization access wire parity", () => {
  test("preset, actor and workspace-scope mirrors match contracts", () => {
    const presets: OrganizationAccessPreset[] = ["read_only", "full", "custom"];
    const actors: OrganizationActor[] = ["user", "organization"];
    expect(presets).toEqual(ContractPreset.options);
    expect(actors).toEqual(ContractActor.options);
    const toScope = (value: z.infer<typeof ContractScope>): OrganizationWorkspaceScope => value;
    const fromScope = (value: OrganizationWorkspaceScope): z.input<typeof ContractScope> => value;
    expect(fromScope(toScope(ContractScope.parse({ kind: "all" })))).toEqual({ kind: "all" });
    expect(ContractScope.parse(policy.workspaceScope)).toEqual(policy.workspaceScope);
  });

  test("policies and requests have bidirectional parity for known permissions", () => {
    // SDK permissions stay open for newer servers; only known permissions are
    // assignable back to today's closed contract enum.
    type KnownPolicy = Omit<OrganizationAccessPolicy, "permissions"> & {
      permissions: KnownPermission[];
    };
    type KnownCreate = Omit<CreateOrganizationApiKeyRequest, "policy"> & {
      policy?: KnownPolicy | undefined;
    };
    type KnownUpdate = Omit<UpdateOrganizationApiKeyRequest, "policy"> & {
      policy?: KnownPolicy | undefined;
    };
    const toPolicy = (value: z.infer<typeof ContractPolicy>): OrganizationAccessPolicy => value;
    const fromPolicy = (value: KnownPolicy): z.input<typeof ContractPolicy> => value;
    const toCreate = (
      value: z.input<typeof ContractCreateRequest>,
    ): CreateOrganizationApiKeyRequest => value;
    const fromCreate = (value: KnownCreate): z.input<typeof ContractCreateRequest> => value;
    const toUpdate = (
      value: z.input<typeof ContractUpdateRequest>,
    ): UpdateOrganizationApiKeyRequest => value;
    const fromUpdate = (value: KnownUpdate): z.input<typeof ContractUpdateRequest> => value;
    expect([toPolicy, fromPolicy, toCreate, fromCreate, toUpdate, fromUpdate]).toHaveLength(6);
    const input = { name: "Policy key", policy } satisfies KnownCreate;
    // access's legacy default remains in contract parsing, not SDK serialization.
    expect(ContractCreateRequest.parse(fromCreate(input))).toEqual({ ...input, access: "full" });
    expect(ContractUpdateRequest.parse(fromUpdate({ description: null, policy }))).toEqual({
      description: null,
      policy,
    });
  });

  test("key, grant and credential optional policy fields survive contract projections", () => {
    const toKey = (value: z.infer<typeof ContractApiKey>): ApiKey => value;
    const toGrant = (value: z.infer<typeof ContractAccessGrant>): AccessGrant => value;
    const toCredential = (value: z.infer<typeof ContractAccessCredential>): AccessCredential =>
      value;
    expect(toKey(ContractApiKey.parse(apiKey()))).toEqual(apiKey());
    const grant = {
      workspaceId: WORKSPACE_ID,
      accountId: ORGANIZATION_ID,
      subjectId: `api_key:${KEY_ID}`,
      permissions: ["workspace:admin"],
      permissionMode: "explicit",
    } satisfies AccessGrant;
    expect(toGrant(ContractAccessGrant.parse(grant))).toEqual(grant);
    const credential = {
      kind: "organization_api_key",
      accountId: ORGANIZATION_ID,
      workspaceId: null,
      policy,
      workspaceScope: policy.workspaceScope,
      effectiveWorkspacePermissions: policy.permissions,
      note: "Selected shared workspaces only",
    } satisfies AccessCredential;
    expect(toCredential(ContractAccessCredential.parse(credential))).toEqual(credential);
  });

  test("PATCH requires at least one change and supports clearing a description", () => {
    expect(ContractUpdateRequest.safeParse({}).success).toBe(false);
    expect(ContractUpdateRequest.parse({ description: null })).toEqual({ description: null });
    expect(ContractUpdateRequest.parse({ name: "Renamed" })).toEqual({ name: "Renamed" });
  });

  test("canonical policy labels add no grants and custom has no implicit permissions", () => {
    expect(ContractPolicy.parse({ ...policy, preset: "full" })).toEqual(policy);
    expect(
      ContractPolicy.parse({ ...policy, permissions: ["workspace:admin"] }).permissions,
    ).toEqual(["workspace:admin"]);
    expect(organizationAccessPresetPermissions("custom")).toEqual([]);
    const canonical = KNOWN_PERMISSIONS.filter(
      (permission) => permission !== "environments:manage" && permission !== "environments:use",
    );
    const read = organizationAccessPresetPermissions("read_only");
    expect(read).not.toContain("secrets:read");
    expect(read).not.toContain("variable-sets:read");
    expect(read).toEqual(
      canonical.filter(
        (permission) =>
          /:(read|list|view|search)$/.test(permission) &&
          permission !== "secrets:read" &&
          permission !== "variable-sets:read",
      ),
    );
    expect(organizationAccessPresetPermissions("full")).toEqual(canonical);
  });

  test("selected scope enforces unique bounded workspace IDs", () => {
    expect(ContractScope.safeParse({ kind: "selected", workspaceIds: [] }).success).toBe(true);
    expect(
      ContractScope.safeParse({ kind: "selected", workspaceIds: [WORKSPACE_ID, WORKSPACE_ID] })
        .success,
    ).toBe(false);
    expect(
      ContractScope.safeParse({ kind: "selected", workspaceIds: ["not-a-uuid"] }).success,
    ).toBe(false);
    const workspaceIds = Array.from(
      { length: 501 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    expect(
      ContractScope.safeParse({ kind: "selected", workspaceIds: workspaceIds.slice(0, 500) })
        .success,
    ).toBe(true);
    expect(ContractScope.safeParse({ kind: "selected", workspaceIds }).success).toBe(false);
  });
});
