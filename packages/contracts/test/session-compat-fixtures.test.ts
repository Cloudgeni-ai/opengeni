import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { z } from "zod";

import {
  AgentConfigRequest,
  CreateSessionAgentField,
  CreateSessionRequest,
  Session,
  sessionAgentFieldNamesOrgAgent,
  WorkspaceWebhookEvent,
} from "../src/index";

/**
 * Compatibility contract for Console agents (organization agents).
 *
 * The fixtures were recorded by parsing each input with the schemas on main
 * (see `recordedFrom` in each file) before any Console agents change touched
 * session create, the Session response or webhook payloads. They include the
 * request bodies CloudGeni's `buildCreateSessionRequestBody` sends (outputs
 * only) and Kontali-style embedding requests. Existing inputs must keep
 * parsing to exactly the recorded output; re-record only for a deliberate,
 * reviewed wire change.
 */
type FixtureCase = { name: string; source: string; input: unknown; parsed: unknown };
type FixtureFile = { recordedFrom: string; cases: FixtureCase[] };

function fixture(name: string): FixtureFile {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/session-compat/${name}.json`, import.meta.url), "utf8"),
  ) as FixtureFile;
}

const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

function expectSameParse(schema: z.ZodType, file: FixtureFile): void {
  expect(file.recordedFrom).toContain("main");
  expect(file.cases.length).toBeGreaterThan(0);
  for (const fixtureCase of file.cases) {
    const result = schema.safeParse(fixtureCase.input);
    if (!result.success) {
      throw new Error(`${fixtureCase.name}: ${JSON.stringify(result.error.issues)}`);
    }
    expect({ name: fixtureCase.name, parsed: wire(result.data) }).toEqual({
      name: fixtureCase.name,
      parsed: fixtureCase.parsed,
    });
  }
}

describe("session wire compatibility (recorded on main)", () => {
  test("CreateSessionRequest parses existing requests exactly as on main", () => {
    expectSameParse(CreateSessionRequest, fixture("create-session-requests"));
  });

  test("Session responses parse exactly as on main", () => {
    expectSameParse(Session, fixture("sessions"));
  });

  test("workspace and organization webhook events parse exactly as on main", () => {
    expectSameParse(WorkspaceWebhookEvent, fixture("webhook-events"));
  });

  test("existing agent objects never name an organization agent", () => {
    for (const fixtureCase of fixture("create-session-requests").cases) {
      const input = fixtureCase.input as { agent?: unknown };
      expect({
        name: fixtureCase.name,
        orgAgent: sessionAgentFieldNamesOrgAgent(input.agent),
      }).toEqual({
        name: fixtureCase.name,
        orgAgent: false,
      });
      if (input.agent === undefined) continue;
      // The widened `agent` field resolves today's object to today's schema, unchanged.
      expect(wire(CreateSessionAgentField.parse(input.agent))).toEqual(
        wire(AgentConfigRequest.parse(input.agent)),
      );
    }
  });

  test("existing Session responses carry no organization agent", () => {
    for (const fixtureCase of fixture("sessions").cases) {
      expect(Object.hasOwn(fixtureCase.parsed as object, "orgAgent")).toBe(false);
    }
  });
});
