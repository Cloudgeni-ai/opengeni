import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { testSettings } from "@opengeni/testing";
import type { AccessGrant } from "@opengeni/contracts";
import { frozenInitiatorForCommandActor } from "@opengeni/db";
import { serviceInitiatorFromHeaders } from "../src/access/service-initiator";
import { requireAccessContext } from "../src/access";
import { creationInitiatorForGrant } from "../src/domain/sessions";
import { personalConnectionDelegationSourceForGrant } from "../src/domain/personal-connection-delegations";

describe("API-key service header provenance", () => {
  test("validates names, flat finite values, byte bound and reserved lineage", () => {
    expect(serviceInitiatorFromHeaders(new Headers())).toBeNull();
    expect(
      serviceInitiatorFromHeaders(
        new Headers({
          "x-opengeni-service-initiator": "cloudgeni:drift",
          "x-opengeni-service-context": '{"job":"42","attempt":1,"scheduled":true}',
        }),
      ),
    ).toEqual({
      serviceInitiator: { kind: "service", subjectId: "cloudgeni:drift" },
      serviceInitiatorContext: { job: "42", attempt: 1, scheduled: true },
    });
    for (const name of ["", "Capital", "-bad", "a".repeat(65), "two names"]) {
      expect(() =>
        serviceInitiatorFromHeaders(
          new Headers({
            "x-opengeni-service-initiator": name,
          }),
        ),
      ).toThrow();
    }
    for (const context of [
      "[]",
      "null",
      '{"nested":{}}',
      '{"v":null}',
      '{"v":1e999}',
      "{bad",
      '{"via":"forged"}',
      JSON.stringify({ v: "é".repeat(1024) }),
    ]) {
      expect(() =>
        serviceInitiatorFromHeaders(
          new Headers({
            "x-opengeni-service-initiator": "drift",
            "x-opengeni-service-context": context,
          }),
        ),
      ).toThrow();
    }
    expect(() =>
      serviceInitiatorFromHeaders(
        new Headers({
          "x-opengeni-service-context": "{}",
        }),
      ),
    ).toThrow("x-opengeni-service-initiator");
  });

  test("asUser conflict is 422 before identity lookup; local humans cannot assert services", async () => {
    const app = new Hono();
    app.get("/", async (c) =>
      c.json(
        await requireAccessContext(c, {
          settings: testSettings({ productAccessMode: "local" }),
          db: {} as never,
        }),
      ),
    );
    const conflict = await app.request("/", {
      headers: {
        "x-opengeni-service-initiator": "drift",
        "x-opengeni-external-actor": "{}",
      },
    });
    expect(conflict.status).toBe(422);
    expect(await conflict.text()).toContain("mutually exclusive");
    const local = await app.request("/", { headers: { "x-opengeni-service-initiator": "drift" } });
    expect(local.status).toBe(422);
    expect(await local.text()).toContain("API key");
  });

  test("the service initiator does not change key authority or borrow personal connections", async () => {
    const grant: AccessGrant = {
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      principalKind: "api_key",
      subjectId: "api_key:key",
      permissions: ["sessions:read"],
      ...serviceInitiatorFromHeaders(new Headers({ "x-opengeni-service-initiator": "drift" })),
    };
    expect(creationInitiatorForGrant(grant)).toEqual({
      initiator: { kind: "service", subjectId: "drift" },
      context: {},
    });
    expect(grant.subjectId).toBe("api_key:key");
    expect(grant.permissions).toEqual(["sessions:read"]);
    expect(personalConnectionDelegationSourceForGrant(grant)).toEqual({ kind: "none" });
    expect(
      await frozenInitiatorForCommandActor({} as never, grant.workspaceId, {
        type: "service",
        subjectId: "drift",
        context: { scheduled: true },
      }),
    ).toEqual({
      initiator: { kind: "service", subjectId: "drift" },
      context: { scheduled: true },
      initiatingHumanSubjectId: null,
    });
  });
});
