import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseSync, type IfStatement } from "oxc-parser";
import {
  AutomationSessionTemplate,
  CreateSessionRequest,
  type Permission,
} from "@opengeni/contracts";
import { OpenGeniClient } from "../src/index";

// Source-only boundary regression. This runs the exact public admission guard
// in isolation, not the full core function, API route, or DB-backed admission.
// SDK requests use an injected in-memory adapter; no service or global mock.
const root = new URL("../../../", import.meta.url);
const recipesPath = new URL(".agents/skills/opengeni-client/references/agent-recipes.md", root);
const configurationPath = new URL(
  ".agents/skills/opengeni-client/references/configure-the-agent.md",
  root,
);
const sessionsPath = new URL("packages/core/src/domain/sessions.ts", root);
const workspaceId = "22222222-2222-4222-8222-222222222222";
const admissionMessage =
  "firstPartyMcpPermissions must not be empty; omit it for the default worker permission set";

type AdmissionError = Error & { status: number };
type HttpExceptionConstructor = new (
  status: number,
  options: { message: string },
) => AdmissionError;
type AdmissionGuard = (
  permissions: Permission[] | undefined,
  exception: HttpExceptionConstructor,
) => void;

async function publicAdmissionGuard() {
  const source = await readFile(sessionsPath, "utf8");
  const parsed = parseSync(sessionsPath.pathname, source);
  expect(parsed.errors).toEqual([]);
  const fn = parsed.program.body.find(
    (node) =>
      node.type === "FunctionDeclaration" && node.id?.name === "createSessionForRequestInFileScope",
  );
  if (fn?.type !== "FunctionDeclaration" || !fn.body)
    throw new Error("public create function not found");
  const guards = fn.body.body.filter(
    (node): node is IfStatement =>
      node.type === "IfStatement" &&
      node.test.type === "LogicalExpression" &&
      node.test.operator === "&&" &&
      node.test.left.type === "Identifier" &&
      node.test.left.name === "firstPartyMcpPermissions" &&
      node.test.right.type === "BinaryExpression" &&
      node.test.right.operator === "===" &&
      node.test.right.left.type === "MemberExpression" &&
      node.test.right.left.object.type === "Identifier" &&
      node.test.right.left.object.name === "firstPartyMcpPermissions" &&
      node.test.right.left.property.type === "Identifier" &&
      node.test.right.left.property.name === "length" &&
      node.test.right.right.type === "Literal" &&
      node.test.right.right.value === 0,
  );
  expect(guards).toHaveLength(1);
  const guard = guards[0]!;
  if (guard.consequent.type !== "BlockStatement")
    throw new Error("unexpected admission guard body");
  expect(guard.consequent.body).toHaveLength(1);
  const rejection = guard.consequent.body[0]!;
  if (rejection.type !== "ThrowStatement" || rejection.argument.type !== "NewExpression") {
    throw new Error("unexpected admission rejection");
  }
  expect(rejection.argument.callee).toMatchObject({ type: "Identifier", name: "HTTPException" });
  expect(rejection.argument.arguments[0]).toMatchObject({ type: "Literal", value: 422 });
  // Only the AST-selected pure guard is evaluated. No surrounding imports,
  // database calls, route handlers, or session creation code are executed.
  const validate = new Function(
    "firstPartyMcpPermissions",
    "HTTPException",
    source.slice(guard.start, guard.end),
  ) as AdmissionGuard;
  const { HTTPException } = (await import(
    Bun.resolveSync("hono/http-exception", new URL("packages/core", root).pathname)
  )) as { HTTPException: HttpExceptionConstructor };
  return (permissions: Permission[] | undefined) => validate(permissions, HTTPException);
}

async function fixture() {
  const validate = await publicAdmissionGuard();
  const requests: { body: Record<string, unknown>; service: string | null }[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://fixture.example.test",
    apiKey: "synthetic-key",
    apiContract: "compatible",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const body = (await request.json()) as Record<string, unknown>;
      requests.push({ body, service: request.headers.get("x-opengeni-service-initiator") });
      const payload = CreateSessionRequest.parse(body);
      try {
        validate(payload.firstPartyMcpPermissions);
        return Response.json({ fixtureOnly: true });
      } catch (error) {
        const refusal = error as AdmissionError;
        if (!Number.isInteger(refusal.status)) throw error;
        return Response.json({ message: refusal.message }, { status: refusal.status });
      }
    },
  });
  return { client, requests };
}

test("the actual public SDK background recipe omits permission overrides, not authority", async () => {
  const markdown = await readFile(recipesPath, "utf8");
  const snippets = [...markdown.matchAll(/```ts\n([\s\S]*?)\n```/gu)]
    .map((match) => match[1]!)
    .filter((snippet) => snippet.includes("acme:reports"));
  expect(snippets).toHaveLength(1);
  const recipe = snippets[0]!;
  expect(parseSync("background-recipe.ts", recipe).errors).toEqual([]);
  const RecipeFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...argumentsValue: string[]
  ) => (
    client: OpenGeniClient,
    workspaceId: string,
    job: { id: string },
    skills: never[],
    tools: never[],
  ) => Promise<void>;
  const run = new RecipeFunction(
    "og",
    "workspaceId",
    "jobRecord",
    "productSkills",
    "selectedProductTools",
    recipe,
  );
  const f = await fixture();
  await run(f.client, workspaceId, { id: "fixture-job" }, [], []);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]!.service).toBe("acme:reports");
  expect(f.requests[0]!.body.firstPartyMcpTools).toEqual([]);
  expect(Object.hasOwn(f.requests[0]!.body, "firstPartyMcpPermissions")).toBe(false);
});

test.each(["ordinary", "asService"] as const)(
  "%s public SDK [] reaches the unchanged 422 guard",
  async (mode) => {
    const f = await fixture();
    const client = mode === "asService" ? f.client.asService("acme:reports") : f.client;
    await expect(
      client.createSession(workspaceId, {
        initialMessage: "fixture request",
        firstPartyMcpTools: [],
        firstPartyMcpPermissions: [],
      }),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining(admissionMessage) });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.body.firstPartyMcpPermissions).toEqual([]);
    expect(f.requests[0]!.service).toBe(mode === "asService" ? "acme:reports" : null);
  },
);

test.each(["omitted", "nonempty"] as const)(
  "%s permissions pass only the isolated public empty-set guard",
  async (mode) => {
    const f = await fixture();
    await f.client.asService("acme:reports").createSession(workspaceId, {
      initialMessage: "fixture request",
      firstPartyMcpTools: [],
      ...(mode === "nonempty"
        ? { firstPartyMcpPermissions: ["sessions:read"] as Permission[] }
        : {}),
    });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.body.firstPartyMcpPermissions).toEqual(
      mode === "nonempty" ? ["sessions:read"] : undefined,
    );
    // This nonempty control does not recommend padding a documentation recipe,
    // or assert that any caller holds this permission or passed full admission.
  },
);

test.each(["omitted", "explicit"] as const)(
  "%s automation template arrays remain valid zero authority",
  (mode) => {
    const template = AutomationSessionTemplate.parse({
      prompt: "fixture automation",
      ...(mode === "explicit" ? { firstPartyMcpTools: [], firstPartyMcpPermissions: [] } : {}),
    });
    expect(template.firstPartyMcpTools).toEqual([]);
    expect(template.firstPartyMcpPermissions).toEqual([]);
  },
);

test("client configuration guidance states the public API limitation and keeps automation scope distinct", async () => {
  const configuration = (await readFile(configurationPath, "utf8")).replace(/\s+/gu, " ");
  expect(configuration).toContain(
    "Public `createSession` rejects `firstPartyMcpPermissions: []` with 422, including `asService` calls.",
  );
  expect(configuration).toContain("Omitting permissions is not zero authority");
  expect(configuration).toContain("Automation session templates");
  expect(configuration).toContain("already-effective internal or linked permission ceiling");
});
