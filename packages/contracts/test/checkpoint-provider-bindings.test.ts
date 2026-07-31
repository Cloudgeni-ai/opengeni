import { describe, expect, test } from "bun:test";
import { canonicalModalCheckpointProviderBinding } from "../src/checkpoint-provider-bindings";

describe("Modal checkpoint provider binding identity", () => {
  test("canonicalizes one exact non-secret wire identity", () => {
    expect(
      canonicalModalCheckpointProviderBinding({
        environment: "main",
        workspaceName: "workspace-a",
        tokenSecret: "must-not-survive",
        serverUrl: "https://api.modal.test",
        version: 1,
      }),
    ).toEqual({
      binding: {
        version: 1,
        serverUrl: "https://api.modal.test",
        workspaceName: "workspace-a",
        environment: "main",
      },
      key: JSON.stringify({
        version: 1,
        serverUrl: "https://api.modal.test",
        workspaceName: "workspace-a",
        environment: "main",
      }),
    });
  });

  test("rejects incomplete, unknown-version, and over-contract identities", () => {
    expect(canonicalModalCheckpointProviderBinding(null)).toBeNull();
    expect(
      canonicalModalCheckpointProviderBinding({
        version: 2,
        serverUrl: "https://api.modal.test",
        workspaceName: "workspace-a",
        environment: "",
      }),
    ).toBeNull();
    expect(
      canonicalModalCheckpointProviderBinding({
        version: 1,
        serverUrl: "https://api.modal.test",
        workspaceName: "",
        environment: "",
      }),
    ).toBeNull();
    expect(
      canonicalModalCheckpointProviderBinding({
        version: 1,
        serverUrl: "x".repeat(1_100),
        workspaceName: "workspace-a",
        environment: "",
      }),
    ).toBeNull();
  });
});
