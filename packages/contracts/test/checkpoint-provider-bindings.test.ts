import { describe, expect, test } from "bun:test";
import {
  canonicalDockerProviderImageBinding,
  canonicalModalCheckpointProviderBinding,
} from "../src/checkpoint-provider-bindings";

describe("Docker provider image binding identity", () => {
  test("canonicalizes the exact endpoint and daemon identity without context aliases", () => {
    expect(
      canonicalDockerProviderImageBinding({
        version: 1,
        endpoint: "unix:///var/run/docker.sock",
        daemonId: "ABCDEF0123456789",
        contextName: "mutable-alias-must-not-survive",
      }),
    ).toEqual({
      binding: {
        version: 1,
        endpoint: "unix:///var/run/docker.sock",
        daemonId: "ABCDEF0123456789",
      },
      key: JSON.stringify({
        version: 1,
        endpoint: "unix:///var/run/docker.sock",
        daemonId: "ABCDEF0123456789",
      }),
    });
  });

  test("rejects empty, control-bearing, and over-contract identities", () => {
    expect(canonicalDockerProviderImageBinding(null)).toBeNull();
    expect(
      canonicalDockerProviderImageBinding({ version: 1, endpoint: "", daemonId: "daemon-a" }),
    ).toBeNull();
    expect(
      canonicalDockerProviderImageBinding({
        version: 1,
        endpoint: "unix:///var/run/docker.sock\nforged",
        daemonId: "daemon-a",
      }),
    ).toBeNull();
    expect(
      canonicalDockerProviderImageBinding({
        version: 1,
        endpoint: `unix:///${"x".repeat(800)}`,
        daemonId: "daemon-a",
      }),
    ).toBeNull();
  });
});

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
