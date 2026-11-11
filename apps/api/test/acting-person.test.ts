import { describe, expect, test } from "bun:test";
import { stampDelegatedHumanAuthorization } from "@opengeni/core";
import { createObservability } from "@opengeni/observability";
import { agentActingAsPerson } from "../src/http/acting-person";

const organizationId = "2d0c3c0e-6a8c-4c43-9a4f-1d6a3b3a9e51";
const subjectId = "user:5b8f0b6e-8d0e-4c1c-9d2a-6e1f0a2b3c4d";

type ErrorBody = {
  error?: { code: string; message: string; details?: Record<string, unknown> };
  subjectId?: string;
};

/** An agent acting as a person who gave it `account:read` only, through the real app. */
async function act(organization: string, permission: "account:read" | "account:admin") {
  const { createApp } = await import("../src/app");
  const { testSettings } = await import("@opengeni/testing/settings");
  const settings = testSettings();
  const app = createApp({
    settings,
    db: {} as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    observability: createObservability(
      { ...settings, observabilityStructuredLogs: false },
      { component: "api" },
    ),
  });
  app.get("/v1/test-only/acting-person", (c) =>
    c.json(agentActingAsPerson(c, organization, permission)),
  );
  const request = new Request("http://localhost/v1/test-only/acting-person");
  stampDelegatedHumanAuthorization(request, {
    organizationId,
    subjectId,
    permissions: ["account:read"],
    workspaceScope: { kind: "all" },
  });
  const response = await app.request(request);
  return { status: response.status, body: (await response.json()) as ErrorBody };
}

describe("an agent acting as a person", () => {
  test("acts within the access the person gave it", async () => {
    expect(await act(organizationId, "account:read")).toEqual({
      status: 200,
      body: { subjectId },
    });
  });

  test("a permission outside that access is refused in a plain sentence, typed", async () => {
    const refused = await act(organizationId, "account:admin");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({
      code: "forbidden",
      message: "This agent's access doesn't cover this action.",
      details: { code: "missing_permission", permission: "account:admin" },
    });
  });

  test("another organization reads as not found, with no permission named", async () => {
    const other = await act("0f7a1c2d-3e4b-4f5a-8b6c-7d8e9f0a1b2c", "account:read");
    expect(other.status).toBe(404);
    expect(other.body.error?.details?.permission).toBeUndefined();
    expect(other.body.error?.details?.code).not.toBe("missing_permission");
  });
});
