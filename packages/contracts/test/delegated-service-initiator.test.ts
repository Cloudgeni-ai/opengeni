import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  signDelegatedAccessToken,
  verifyDelegatedAccessToken,
  type DelegatedAccessTokenPayload,
} from "../src/index";

const SECRET = crypto.randomUUID();
const BASE: DelegatedAccessTokenPayload = {
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  subjectId: "host:automation-gateway",
  permissions: ["sessions:create", "sessions:control"],
  exp: 2_000_000_000,
};

function rawDelegatedToken(prefix: "ogd_" | "ogd2_", payload: DelegatedAccessTokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signed = prefix === "ogd2_" ? `${prefix}${encoded}` : encoded;
  const signature = createHmac("sha256", SECRET).update(signed).digest("base64url");
  return `${prefix}${encoded}.${signature}`;
}

describe("delegated service initiator claims", () => {
  test("round-trips a signed causal service separately from the authorizing subject", async () => {
    const token = await signDelegatedAccessToken(SECRET, {
      ...BASE,
      serviceInitiator: {
        kind: "service",
        subjectId: "external-scheduler",
        label: "External scheduler",
      },
      serviceInitiatorContext: {
        occurrenceId: "occurrence-42",
        trigger: "cron",
      },
    });

    expect(token.startsWith("ogd2_")).toBe(true);
    expect(token.startsWith("ogd_")).toBe(false);

    expect(await verifyDelegatedAccessToken(SECRET, token, 1_900_000_000)).toMatchObject({
      subjectId: "host:automation-gateway",
      serviceInitiator: {
        kind: "service",
        subjectId: "external-scheduler",
        label: "External scheduler",
      },
      serviceInitiatorContext: {
        occurrenceId: "occurrence-42",
        trigger: "cron",
      },
    });
    expect(
      await verifyDelegatedAccessToken(SECRET, token.replace(/^ogd2_/, "ogd_"), 1_900_000_000),
    ).toBeNull();
    expect(await verifyDelegatedAccessToken(SECRET, `ogd_${token}`, 1_900_000_000)).toBeNull();

    const ordinary = await signDelegatedAccessToken(SECRET, BASE);
    expect(ordinary.startsWith("ogd_")).toBe(true);
    expect(await verifyDelegatedAccessToken(SECRET, ordinary, 1_900_000_000)).toMatchObject(BASE);
    expect(
      await verifyDelegatedAccessToken(SECRET, ordinary.replace(/^ogd_/, "ogd2_"), 1_900_000_000),
    ).toBeNull();

    expect(
      await verifyDelegatedAccessToken(
        SECRET,
        rawDelegatedToken("ogd_", {
          ...BASE,
          serviceInitiator: { kind: "service", subjectId: "external-scheduler" },
        }),
        1_900_000_000,
      ),
    ).toBeNull();
    expect(
      await verifyDelegatedAccessToken(SECRET, rawDelegatedToken("ogd2_", BASE), 1_900_000_000),
    ).toBeNull();
  });

  test("rejects human impersonation, orphan context, and exact-attempt replacement", async () => {
    await expect(
      signDelegatedAccessToken(SECRET, {
        ...BASE,
        serviceInitiator: {
          kind: "subject",
          subjectId: "user:impersonated",
        },
      } as never),
    ).rejects.toThrow();

    await expect(
      signDelegatedAccessToken(SECRET, {
        ...BASE,
        serviceInitiatorContext: { occurrenceId: "orphan" },
      } as never),
    ).rejects.toThrow("serviceInitiatorContext requires serviceInitiator");

    await expect(
      signDelegatedAccessToken(SECRET, {
        ...BASE,
        serviceInitiator: {
          kind: "service",
          subjectId: "external-scheduler",
        },
        serviceInitiatorContext: { label: "smuggled identity label" },
      }),
    ).rejects.toThrow("label is reserved OpenGeni initiator context");

    await expect(
      signDelegatedAccessToken(SECRET, {
        ...BASE,
        serviceInitiator: {
          kind: "service",
          subjectId: "unattributed-legacy",
        },
      }),
    ).rejects.toThrow("unattributed-legacy is reserved for migrated rows");

    await expect(
      signDelegatedAccessToken(SECRET, {
        ...BASE,
        serviceInitiator: {
          kind: "service",
          subjectId: "external-scheduler",
        },
        serviceInitiatorContext: { via: [{ kind: "forged-agent" }] },
      }),
    ).rejects.toThrow("via is reserved OpenGeni initiator context");

    await expect(
      signDelegatedAccessToken(SECRET, {
        ...BASE,
        serviceInitiator: {
          kind: "service",
          subjectId: "external-scheduler",
        },
        serviceInitiatorContext: { occurrence: "x".repeat(4097) },
      }),
    ).rejects.toThrow("service initiator context exceeds 4096 UTF-8 bytes");

    await expect(
      signDelegatedAccessToken(SECRET, {
        ...BASE,
        serviceInitiator: {
          kind: "service",
          subjectId: "external-scheduler",
        },
        sessionId: "00000000-0000-4000-8000-000000000003",
        turnId: "00000000-0000-4000-8000-000000000004",
        attemptId: "00000000-0000-4000-8000-000000000005",
        executionGeneration: 1,
      }),
    ).rejects.toThrow("serviceInitiator cannot replace an exact agent-attempt initiator");
  });
});
