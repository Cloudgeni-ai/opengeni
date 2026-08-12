import { describe, expect, test } from "bun:test";
import { buildSchema, introspectionFromSchema } from "graphql";

import {
  compileGraphqlRevision,
  compileOpenApiRevision,
  directIntegrationTransport,
  fetchGraphqlIntrospection,
  IntegrationInvocationError,
  invokeGraphqlOperation,
  invokeOpenApiOperation,
  type IntegrationCredentialPlacement,
} from "../src";

const financeAuthority = {
  accountId: "account-linear-emulator",
  workspaceId: "workspace-linear-emulator",
  sessionId: "session-linear-finance",
  turnId: "turn-linear-finance",
  attemptId: "attempt-linear-finance",
  initiatingSubjectId: "subject-linear-owner",
  connectionRef: "connection-linear-finance",
};

const salesAuthority = {
  ...financeAuthority,
  sessionId: "session-linear-sales",
  turnId: "turn-linear-sales",
  attemptId: "attempt-linear-sales",
  connectionRef: "connection-linear-sales",
};

describe("custom API protocol emulator acceptance", () => {
  test("executes OpenAPI no-auth plus header/query/cookie credentials without cross-placement", async () => {
    const observed: Array<{
      path: string;
      authorization: string | null;
      queryKey: string | null;
      cookie: string | null;
    }> = [];
    const transport = directIntegrationTransport(async (input, init) => {
      const url = new URL(String(input));
      observed.push({
        path: url.pathname,
        authorization: new Headers(init?.headers).get("authorization"),
        queryKey: url.searchParams.get("api_key"),
        cookie: new Headers(init?.headers).get("cookie"),
      });
      return new Response(JSON.stringify({ ok: true, path: url.pathname }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    for (const scenario of [
      { label: "anonymous", placements: null },
      {
        label: "header",
        placements: [
          { carrier: "header", name: "Authorization", prefix: "Bearer ", value: "finance" },
        ] satisfies IntegrationCredentialPlacement[],
      },
      {
        label: "query",
        placements: [
          { carrier: "query", name: "api_key", value: "finance-query" },
        ] satisfies IntegrationCredentialPlacement[],
      },
      {
        label: "cookie",
        placements: [
          { carrier: "cookie", name: "linear_session", value: "finance-cookie" },
        ] satisfies IntegrationCredentialPlacement[],
      },
    ] as const) {
      const revision = compileOpenApiRevision(
        {
          openapi: "3.1.0",
          info: { title: `Linear-like ${scenario.label}`, version: "1.0.0" },
          servers: [{ url: "https://linear.example.test/api/" }],
          paths: {
            [`/${scenario.label}`]: {
              get: {
                operationId: `${scenario.label}.issues`,
                responses: { "200": { description: "Issues" } },
              },
            },
          },
        },
        { integrationId: `linear-${scenario.label}` },
      );
      const toolId = revision.tools[0]!.id;
      const result = await invokeOpenApiOperation(
        {
          revision,
          transport,
          authority: financeAuthority,
          ...(scenario.placements
            ? {
                credentialResolver: {
                  resolve: async () => ({
                    audience: { origin: "https://linear.example.test", pathPrefix: "/api/" },
                    placements: scenario.placements,
                  }),
                },
              }
            : {}),
        },
        toolId,
        {},
      );
      expect(result).toMatchObject({ ok: true, status: 200 });
    }

    expect(observed).toEqual([
      { path: "/api/anonymous", authorization: null, queryKey: null, cookie: null },
      {
        path: "/api/header",
        authorization: "Bearer finance",
        queryKey: null,
        cookie: null,
      },
      {
        path: "/api/query",
        authorization: null,
        queryKey: "finance-query",
        cookie: null,
      },
      {
        path: "/api/cookie",
        authorization: null,
        queryKey: null,
        cookie: "linear_session=finance-cookie",
      },
    ]);
  });

  test("retries authenticated GraphQL preview safely, then keeps Finance and Sales identities independent", async () => {
    const introspection = introspectionFromSchema(
      buildSchema(`
        type Issue { id: ID!, title: String! }
        type Query { issues: [Issue!]! }
      `),
    );
    const calls: Array<{ connectionRef: string | undefined; authorization: string | null }> = [];
    const transport = directIntegrationTransport(async (_input, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      const body = JSON.parse(String(init?.body)) as { query?: string };
      if (!authorization) return new Response(null, { status: 401 });
      calls.push({
        connectionRef:
          authorization === "Bearer finance-token"
            ? financeAuthority.connectionRef
            : salesAuthority.connectionRef,
        authorization,
      });
      if (body.query?.includes("IntrospectionQuery")) {
        return Response.json({ data: introspection });
      }
      return Response.json({
        data: {
          issues: [
            {
              id: authorization === "Bearer finance-token" ? "FIN-1" : "SAL-1",
              title: authorization === "Bearer finance-token" ? "Finance" : "Sales",
            },
          ],
        },
      });
    });

    await expect(
      fetchGraphqlIntrospection({
        endpoint: "https://linear.example.test/graphql",
        transport,
        authority: { ...financeAuthority, connectionRef: undefined },
      }),
    ).rejects.toMatchObject({ code: "graphql_introspection_rejected", status: 401 });

    const credentialResolver = {
      resolve: async (request: { connectionRef?: string }) => {
        const token =
          request.connectionRef === financeAuthority.connectionRef
            ? "finance-token"
            : request.connectionRef === salesAuthority.connectionRef
              ? "sales-token"
              : null;
        return token
          ? {
              audience: { origin: "https://linear.example.test", pathPrefix: "/graphql" },
              placements: [
                {
                  carrier: "header" as const,
                  name: "Authorization",
                  prefix: "Bearer ",
                  value: token,
                },
              ],
            }
          : null;
      },
    };
    const authenticatedIntrospection = await fetchGraphqlIntrospection({
      endpoint: "https://linear.example.test/graphql",
      transport,
      authority: financeAuthority,
      credentialResolver,
    });
    const revision = compileGraphqlRevision(authenticatedIntrospection, {
      integrationId: "linear-like-graphql",
      endpoint: "https://linear.example.test/graphql",
      name: "Linear-like GraphQL",
    });
    const [finance, sales] = await Promise.all([
      invokeGraphqlOperation(
        {
          revision,
          endpoint: "https://linear.example.test/graphql",
          transport,
          authority: financeAuthority,
          credentialResolver,
        },
        "query_issues",
        { select: "id title" },
      ),
      invokeGraphqlOperation(
        {
          revision,
          endpoint: "https://linear.example.test/graphql",
          transport,
          authority: salesAuthority,
          credentialResolver,
        },
        "query_issues",
        { select: "id title" },
      ),
    ]);
    expect(finance).toMatchObject({ data: { issues: [{ id: "FIN-1" }] } });
    expect(sales).toMatchObject({ data: { issues: [{ id: "SAL-1" }] } });
    expect(calls.map((call) => call.authorization)).toEqual([
      "Bearer finance-token",
      "Bearer finance-token",
      "Bearer sales-token",
    ]);
  });

  test("rejects near-identical wrong-domain and wrong-Connection credentials before provider invocation", async () => {
    const revision = compileOpenApiRevision(
      {
        openapi: "3.1.0",
        info: { title: "Linear-like negative", version: "1.0.0" },
        servers: [{ url: "https://linear.example.test/api/" }],
        paths: {
          "/issues": {
            get: {
              operationId: "issues.list",
              responses: { "200": { description: "Issues" } },
            },
          },
        },
      },
      { integrationId: "linear-negative" },
    );
    let providerCalls = 0;
    const transport = directIntegrationTransport(async () => {
      providerCalls += 1;
      return Response.json({ ok: true });
    });

    await expect(
      invokeOpenApiOperation(
        {
          revision,
          transport,
          authority: financeAuthority,
          credentialResolver: {
            resolve: async () => ({
              audience: { origin: "https://linear.example.test.evil", pathPrefix: "/api/" },
              placements: [{ carrier: "header", name: "Authorization", value: "Bearer wrong" }],
            }),
          },
        },
        "issues_list",
        {},
      ),
    ).rejects.toBeInstanceOf(IntegrationInvocationError);

    let wrongConnectionError: unknown;
    try {
      await invokeOpenApiOperation(
        {
          revision,
          transport,
          authority: salesAuthority,
          credentialResolver: {
            resolve: async (request) =>
              request.connectionRef === financeAuthority.connectionRef
                ? {
                    audience: { origin: "https://linear.example.test", pathPrefix: "/api/" },
                    placements: [
                      { carrier: "header", name: "Authorization", value: "Bearer finance" },
                    ],
                  }
                : null,
          },
        },
        "issues_list",
        {},
      );
    } catch (error) {
      wrongConnectionError = error;
    }
    expect(wrongConnectionError).toBeInstanceOf(IntegrationInvocationError);
    expect((wrongConnectionError as IntegrationInvocationError).code).toBe("connection_required");
    expect((wrongConnectionError as IntegrationInvocationError).outcome).toBe("not_started");
    expect(providerCalls).toBe(0);
  });
});
