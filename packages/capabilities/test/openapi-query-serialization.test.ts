import { expect, test } from "bun:test";
import {
  compileOpenApiRevision,
  invokeOpenApiOperation,
  filterOpenApiDocumentForDefinition,
  MICROSOFT_TEAMS_INTEGRATION_DEFINITION,
} from "../src";
import { canonicalJson, immutableRevisionId, sha256Hex } from "../src/revision";

// Microsoft Graph declares $select/$expand/$orderby as form, explode:false arrays.
// https://github.com/microsoftgraph/msgraph-metadata/blob/master/openapi/v1.0/openapi.yaml
const document = {
  openapi: "3.0.1",
  info: { title: "Graph query fixture", version: "1" },
  servers: [{ url: "https://graph.microsoft.com/v1.0" }],
  components: {
    parameters: {
      select: {
        name: "$select",
        in: "query",
        style: "form",
        explode: false,
        schema: { type: "array", items: { type: "string" } },
      },
    },
  },
  paths: {
    "/users/{user-id}": {
      parameters: [
        { name: "user-id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "$select",
          in: "query",
          explode: true,
          schema: { type: "array", items: { type: "string" } },
        },
      ],
      get: {
        operationId: "users.user.GetUser",
        parameters: [
          { $ref: "#/components/parameters/select" },
          {
            name: "$expand",
            in: "query",
            explode: false,
            schema: { type: "array", items: { type: "string" } },
          },
          {
            name: "$orderby",
            in: "query",
            style: "form",
            explode: false,
            schema: { type: "array", items: { type: "string" } },
          },
          {
            name: "tag",
            in: "query",
            style: "form",
            explode: true,
            schema: { type: "array", items: { type: "string" } },
          },
          { name: "defaultTag", in: "query", schema: { type: "array", items: { type: "string" } } },
          { name: "$filter", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "Profile" } },
      },
    },
  },
};
const compile = () => compileOpenApiRevision(document, { definitionId: "graph-query-fixture" });

async function invoke(query: Record<string, unknown>, revision = compile()) {
  let observed: URL | undefined;
  const result = await invokeOpenApiOperation(
    {
      revision,
      authority: { accountId: "fixture-account", workspaceId: "fixture-workspace" },
      transport: {
        fetch: async (input) => {
          observed = new URL(String(input));
          const repeated = ["$select", "$expand", "$orderby"].some(
            (key) => observed!.searchParams.getAll(key).length > 1,
          );
          return Response.json(
            repeated ? { error: "Query option specified more than once" } : { id: "fixture-user" },
            { status: repeated ? 400 : 200 },
          );
        },
      },
    },
    "users_user_getuser",
    { path: { "user-id": "person@example.test" }, query },
  );
  return { result, url: observed! };
}

test("Graph multi-property queries survive compile and invocation as one comma-separated option", async () => {
  const { result, url } = await invoke({
    $select: ["id", "displayName", "userPrincipalName", "mail"],
    $expand: ["manager", "directReports"],
    $orderby: ["displayName desc", "id"],
  });
  expect(result).toMatchObject({ ok: true, status: 200 });
  expect(url.pathname).toBe("/v1.0/users/person%40example.test");
  expect(url.searchParams.getAll("$select")).toEqual(["id,displayName,userPrincipalName,mail"]);
  expect(url.searchParams.getAll("$expand")).toEqual(["manager,directReports"]);
  expect(url.searchParams.getAll("$orderby")).toEqual(["displayName desc,id"]);
});

test("default and explicit exploded query arrays stay repeated and values remain encoded", async () => {
  const filter = "displayName eq 'A&B+#C'";
  const { url } = await invoke({
    tag: ["one", "two"],
    defaultTag: ["three", "four"],
    $select: ["id"],
    $filter: filter,
  });
  expect(url.searchParams.getAll("tag")).toEqual(["one", "two"]);
  expect(url.searchParams.getAll("defaultTag")).toEqual(["three", "four"]);
  expect(url.searchParams.getAll("$select")).toEqual(["id"]);
  expect(url.searchParams.get("$filter")).toBe(filter);
  expect(url.hash).toBe("");
  expect([...url.searchParams.keys()]).toEqual([
    "tag",
    "tag",
    "defaultTag",
    "defaultTag",
    "$select",
    "$filter",
  ]);
});

test("corrected executable bindings have a new identity without rewriting frozen old revisions", async () => {
  const revision = compile();
  const legacyDigest = sha256Hex(
    canonicalJson({
      document,
      baseUrl: "https://graph.microsoft.com/v1.0",
      serverUrls: { users_user_getuser: "https://graph.microsoft.com/v1.0" },
    }),
  );
  expect(revision.contentSha256).not.toBe(legacyDigest);
  const old = {
    ...structuredClone(revision),
    id: immutableRevisionId("openapi", legacyDigest),
    contentSha256: legacyDigest,
  };
  for (const binding of Object.values(old.bindings)) {
    for (const parameter of binding.parameters) {
      delete (parameter as { style?: string }).style;
      delete (parameter as { explode?: boolean }).explode;
    }
  }
  const { result, url } = await invoke({ $select: ["id", "displayName"] }, old);
  expect(url.searchParams.getAll("$select")).toEqual(["id", "displayName"]);
  expect(result).toMatchObject({ ok: false, status: 400 });
});

test("default serialization retains the previous executable identity", () => {
  const defaults = JSON.parse(
    JSON.stringify(document, (key, value) =>
      key === "style" || key === "explode" ? undefined : value,
    ),
  );
  const revision = compileOpenApiRevision(defaults, { definitionId: "default-query-fixture" });
  const legacyDigest = sha256Hex(
    canonicalJson({
      document: defaults,
      baseUrl: "https://graph.microsoft.com/v1.0",
      serverUrls: { users_user_getuser: "https://graph.microsoft.com/v1.0" },
    }),
  );
  expect(revision.contentSha256).toBe(legacyDigest);
  const exploded = structuredClone(defaults);
  exploded.paths["/users/{user-id}"].get.parameters.push({
    name: "extraTag",
    in: "query",
    style: "form",
    explode: true,
    schema: { type: "array", items: { type: "string" } },
  });
  const explicit = compileOpenApiRevision(exploded, { definitionId: "default-query-fixture" });
  expect(explicit.contentSha256).toBe(
    sha256Hex(
      canonicalJson({
        document: exploded,
        baseUrl: "https://graph.microsoft.com/v1.0",
        serverUrls: { users_user_getuser: "https://graph.microsoft.com/v1.0" },
      }),
    ),
  );
  expect(
    explicit.bindings.users_user_getuser!.parameters.find((p) => p.name === "extraTag"),
  ).toEqual({
    name: "extraTag",
    location: "query",
    required: false,
    schema: { type: "array", items: { type: "string" } },
  });
});

test("the curated Teams profile tool keeps its array schema and uses Graph query encoding", async () => {
  const filtered = filterOpenApiDocumentForDefinition(
    document,
    MICROSOFT_TEAMS_INTEGRATION_DEFINITION,
  );
  const revision = compileOpenApiRevision(filtered, {
    definitionId: "microsoft-teams",
    schemaMode: "provider_validated_json",
  });
  expect(revision.tools[0]!.inputSchema).toMatchObject({
    properties: {
      query: { properties: { $select: { type: "array", items: { type: "string" } } } },
    },
  });
  const { result, url } = await invoke(
    { $select: ["id", "displayName", "userPrincipalName", "mail"] },
    revision,
  );
  expect(result).toMatchObject({ ok: true, status: 200 });
  expect(url.searchParams.getAll("$select")).toEqual(["id,displayName,userPrincipalName,mail"]);
});
