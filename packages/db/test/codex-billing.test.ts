import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import type { Database } from "../src/index";
import {
  isCodexBilledModel,
  isCodexBilledTurn,
  workspaceCodexSubscriptionActive,
} from "../src/index";

function poisonDatabase(failure: string | Error): Database {
  return new Proxy(
    {},
    {
      get() {
        throw typeof failure === "string" ? new Error(failure) : failure;
      },
    },
  ) as unknown as Database;
}

describe("isCodexBilledModel (pure prefix test)", () => {
  test("true for a codex/<slug> id", () => {
    expect(isCodexBilledModel("codex/gpt-5.6-sol")).toBe(true);
  });
  test("false for a normal model id, null, and undefined", () => {
    expect(isCodexBilledModel("gpt-5")).toBe(false);
    expect(isCodexBilledModel("scripted-model")).toBe(false);
    expect(isCodexBilledModel(null)).toBe(false);
    expect(isCodexBilledModel(undefined)).toBe(false);
  });
});

describe("workspaceCodexSubscriptionActive", () => {
  // Enabled-path admission now deliberately locks the workspace rotation row
  // and evaluates legacy versus leased pool health in one RLS transaction. The
  // native-Postgres codex-credential-leases suite covers those row/status cases;
  // this pure suite owns only the no-read deployment fast path.
  test("false when the feature is disabled (never reads the db)", async () => {
    // Pass a poisoned db: if it were read the call would throw, proving no read.
    const poison = poisonDatabase("db must not be read when feature disabled");
    const settings = testSettings({ codexSubscriptionEnabled: false });
    expect(await workspaceCodexSubscriptionActive(poison, settings, "ws_1")).toBe(false);
  });

  test("rethrows the exact read failure while public console output stays structural", async () => {
    const sentinel = "SECRET_SENTINEL_123";
    const workspaceId = `workspace-${sentinel}`;
    const SecretSentinelError = class SECRET_SENTINEL_123 extends Error {};
    const exactError = Object.assign(new SecretSentinelError(`database failed ${sentinel}`), {
      name: sentinel,
      code: sentinel,
      cause: { exact: sentinel },
    });
    const observed: Array<[unknown, unknown]> = [];
    const originalError = console.error;
    console.error = (message?: unknown, attributes?: unknown) => {
      observed.push([message, attributes]);
    };
    let thrown: unknown;
    try {
      await workspaceCodexSubscriptionActive(
        poisonDatabase(exactError),
        testSettings({ codexSubscriptionEnabled: true }),
        workspaceId,
      );
    } catch (error) {
      thrown = error;
    } finally {
      console.error = originalError;
    }

    expect(thrown).toBe(exactError);
    expect(exactError.message).toBe(`database failed ${sentinel}`);
    expect(exactError.constructor.name).toBe(sentinel);
    expect(exactError.code).toBe(sentinel);
    expect(observed).toEqual([
      [
        "workspace Codex subscription credential read failed after retries",
        {
          errorClass: "CredentialReadOperationError",
          errorCode: "codex_active_credential_read_failed",
          origin: "db",
        },
      ],
    ]);
    expect(JSON.stringify(observed)).not.toContain(sentinel);
    expect(JSON.stringify(observed)).not.toContain(workspaceId);
  });
});

describe("isCodexBilledTurn (canonical predicate)", () => {
  test("codex model + precomputed active credential => true without a second db read", async () => {
    const settings = testSettings({ codexSubscriptionEnabled: true });
    expect(
      await isCodexBilledTurn({
        db: poisonDatabase("precomputed activity must avoid a second db read"),
        settings,
        workspaceId: "ws_1",
        model: "codex/gpt-5.6-sol",
        active: true,
      }),
    ).toBe(true);
  });

  test("codex model + precomputed inactive credential => false (no free bypass)", async () => {
    const settings = testSettings({ codexSubscriptionEnabled: true });
    expect(
      await isCodexBilledTurn({
        db: poisonDatabase("precomputed activity must avoid a second db read"),
        settings,
        workspaceId: "ws_1",
        model: "codex/gpt-5.6-sol",
        active: false,
      }),
    ).toBe(false);
  });

  test("codex model but feature disabled => false", async () => {
    const poison = poisonDatabase("db must not be read when feature disabled");
    const settings = testSettings({ codexSubscriptionEnabled: false });
    expect(
      await isCodexBilledTurn({
        db: poison,
        settings,
        workspaceId: "ws_1",
        model: "codex/gpt-5.6-sol",
      }),
    ).toBe(false);
  });

  test("non-codex model => false WITHOUT a credential read (prefix is a necessary condition)", async () => {
    // Poisoned db proves the common non-codex path issues no credential read.
    const poison = poisonDatabase("db must not be read for a non-codex model");
    const settings = testSettings({ codexSubscriptionEnabled: true });
    expect(
      await isCodexBilledTurn({
        db: poison,
        settings,
        workspaceId: "ws_1",
        model: "scripted-model",
      }),
    ).toBe(false);
  });
});
