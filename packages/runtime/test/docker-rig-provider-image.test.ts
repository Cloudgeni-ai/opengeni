import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import {
  buildDockerImmutableImage,
  deleteDockerImmutableProviderImage,
  recoverDockerImmutableProviderImageBuild,
} from "../src/sandbox/providers/docker";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const TAG = `opengeni-rig-provider:${REQUEST_ID}`;
const CONTAINER_ID = "a".repeat(64);
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const ENDPOINT = "unix:///var/run/docker.sock";
const DAEMON_ID = "daemon-a";
const PROVIDER_BINDING = { version: 1, endpoint: ENDPOINT, daemonId: DAEMON_ID } as const;
const PROVIDER_BINDING_KEY = JSON.stringify(PROVIDER_BINDING);

function imageInspection(imageId = IMAGE_ID, requestId = REQUEST_ID): string {
  return `${imageId}\n1\n${requestId}\n`;
}

function deletionInspection(repoTags: readonly string[] | null = [TAG]): string {
  return `${JSON.stringify(IMAGE_ID)}\n${JSON.stringify({
    "io.opengeni.rig-provider-image": "1",
    "io.opengeni.rig-provider-build-request": REQUEST_ID,
  })}\n${JSON.stringify(repoTags)}\n`;
}

function dockerOperation(args: string[]): string[] {
  if (args[0] === "context") return args;
  if (args[0] !== "--host" || args[1] !== ENDPOINT) {
    throw new Error(`Docker daemon command was not endpoint-pinned: ${args.join(" ")}`);
  }
  return args.slice(2);
}

function bindingCommand(args: string[]): { stdout: string; stderr: string } | null {
  const operation = dockerOperation(args);
  if (operation[0] === "context") return { stdout: `${JSON.stringify(ENDPOINT)}\n`, stderr: "" };
  if (operation[0] === "info") return { stdout: `${JSON.stringify(DAEMON_ID)}\n`, stderr: "" };
  return null;
}

describe("Docker immutable Rig provider images", () => {
  test("commits the exact running verifier under the deterministic request tag", async () => {
    const calls: string[][] = [];
    let imageInspections = 0;
    const result = await buildDockerImmutableImage(
      {
        settings: testSettings({ sandboxBackend: "docker" }),
        session: { state: { containerId: CONTAINER_ID } },
        requestId: REQUEST_ID,
        timeoutMs: 5_000,
      },
      async (args) => {
        calls.push(args);
        const binding = bindingCommand(args);
        if (binding) return binding;
        const operation = dockerOperation(args);
        if (operation[0] === "image" && operation[1] === "inspect") {
          imageInspections += 1;
          if (imageInspections === 1) {
            throw Object.assign(new Error("missing image"), {
              stderr: `Error: No such image: ${TAG}\n`,
            });
          }
          return { stdout: imageInspection(), stderr: "" };
        }
        if (operation[0] === "inspect") {
          return { stdout: `${CONTAINER_ID}\ntrue\n`, stderr: "" };
        }
        if (operation[0] === "commit") {
          return { stdout: `${IMAGE_ID}\n`, stderr: "" };
        }
        throw new Error(`unexpected Docker command: ${args.join(" ")}`);
      },
    );

    expect(result).toEqual({
      provider: "docker",
      backend: "docker",
      imageId: IMAGE_ID,
      imageDigest: null,
      providerBindingKey: PROVIDER_BINDING_KEY,
      providerBinding: PROVIDER_BINDING,
    });
    const commit = calls.map(dockerOperation).find((args) => args[0] === "commit");
    expect(commit).toEqual([
      "commit",
      "--pause=true",
      "--change",
      "LABEL io.opengeni.rig-provider-image=1",
      "--change",
      `LABEL io.opengeni.rig-provider-build-request=${REQUEST_ID}`,
      CONTAINER_ID,
      TAG,
    ]);
    expect(imageInspections).toBe(2);
    expect(
      calls.filter((args) => args[0] !== "context").every((args) => args[0] === "--host"),
    ).toBe(true);
  });

  test("reuses the exact labeled image after an acknowledgement-loss retry", async () => {
    const calls: string[][] = [];
    const result = await buildDockerImmutableImage(
      {
        settings: testSettings({ sandboxBackend: "docker" }),
        session: { state: { containerId: "c".repeat(64) } },
        requestId: REQUEST_ID,
        timeoutMs: 5_000,
      },
      async (args) => {
        calls.push(args);
        const binding = bindingCommand(args);
        if (binding) return binding;
        return { stdout: imageInspection(), stderr: "" };
      },
    );

    expect(result.imageId).toBe(IMAGE_ID);
    expect(calls).toHaveLength(3);
    expect(dockerOperation(calls[2]!).slice(0, 2)).toEqual(["image", "inspect"]);
  });

  test("rejects a deterministic tag owned by another build protocol", async () => {
    await expect(
      buildDockerImmutableImage(
        {
          settings: testSettings({ sandboxBackend: "docker" }),
          session: { state: { containerId: CONTAINER_ID } },
          requestId: REQUEST_ID,
          timeoutMs: 5_000,
        },
        async (args) =>
          bindingCommand(args) ?? {
            stdout: imageInspection(IMAGE_ID, crypto.randomUUID()),
            stderr: "",
          },
      ),
    ).rejects.toThrow("owned by another build protocol");
  });

  test("recovers only the exact labeled request on the persisted daemon", async () => {
    const result = await recoverDockerImmutableProviderImageBuild(
      testSettings({ sandboxBackend: "docker" }),
      {
        requestId: REQUEST_ID,
        timeoutMs: 5_000,
        expectedProviderBindingKey: PROVIDER_BINDING_KEY,
      },
      async (args) => bindingCommand(args) ?? { stdout: imageInspection(), stderr: "" },
    );
    expect(result).toMatchObject({
      backend: "docker",
      imageId: IMAGE_ID,
      providerBindingKey: PROVIDER_BINDING_KEY,
    });
  });

  test("refuses build dispatch after Docker daemon binding drift", async () => {
    const calls: string[][] = [];
    await expect(
      buildDockerImmutableImage(
        {
          settings: testSettings({ sandboxBackend: "docker" }),
          session: { state: { containerId: CONTAINER_ID } },
          requestId: REQUEST_ID,
          timeoutMs: 5_000,
          expectedProviderBindingKey: JSON.stringify({
            ...PROVIDER_BINDING,
            daemonId: "daemon-before-rotation",
          }),
        },
        async (args) => {
          calls.push(args);
          return bindingCommand(args) ?? { stdout: "", stderr: "" };
        },
      ),
    ).rejects.toThrow("daemon binding changed before dispatch");
    expect(calls.map(dockerOperation).some((args) => args[0] === "commit")).toBe(false);
  });

  test("deletes only the exact labeled image ID and verifies disappearance", async () => {
    const calls: string[][] = [];
    let exactImageInspections = 0;
    const outcome = await deleteDockerImmutableProviderImage(
      testSettings({ sandboxBackend: "docker" }),
      {
        requestId: REQUEST_ID,
        imageId: IMAGE_ID,
        timeoutMs: 5_000,
        expectedProviderBindingKey: PROVIDER_BINDING_KEY,
      },
      async (args) => {
        calls.push(args);
        const binding = bindingCommand(args);
        if (binding) return binding;
        const operation = dockerOperation(args);
        if (operation[0] === "image" && operation[1] === "inspect" && args.at(-1) === TAG) {
          return { stdout: imageInspection(), stderr: "" };
        }
        if (operation[0] === "image" && operation[1] === "inspect" && args.at(-1) === IMAGE_ID) {
          exactImageInspections += 1;
          if (exactImageInspections === 1) return { stdout: deletionInspection(), stderr: "" };
          throw Object.assign(new Error("missing image"), {
            stderr: `Error: No such image: ${IMAGE_ID}\n`,
          });
        }
        if (operation[0] === "image" && operation[1] === "rm") {
          return { stdout: "deleted\n", stderr: "" };
        }
        throw new Error(`unexpected Docker command: ${args.join(" ")}`);
      },
    );

    expect(outcome).toBe("deleted");
    expect(
      calls.map(dockerOperation).find((args) => args[0] === "image" && args[1] === "rm"),
    ).toEqual(["image", "rm", IMAGE_ID]);
    expect(calls.flat()).not.toContain("--force");
  });

  test("treats an already absent exact Docker image as idempotent success", async () => {
    const outcome = await deleteDockerImmutableProviderImage(
      testSettings({ sandboxBackend: "docker" }),
      {
        requestId: REQUEST_ID,
        imageId: IMAGE_ID,
        timeoutMs: 5_000,
        expectedProviderBindingKey: PROVIDER_BINDING_KEY,
      },
      async (args) => {
        const binding = bindingCommand(args);
        if (binding) return binding;
        throw Object.assign(new Error("missing image"), {
          stderr: `Error: No such image: ${args.at(-1)}\n`,
        });
      },
    );
    expect(outcome).toBe("not_found");
  });

  test("refuses exact deletion while another repository tag shares the image", async () => {
    let removeCalled = false;
    await expect(
      deleteDockerImmutableProviderImage(
        testSettings({ sandboxBackend: "docker" }),
        {
          requestId: REQUEST_ID,
          imageId: IMAGE_ID,
          timeoutMs: 5_000,
          expectedProviderBindingKey: PROVIDER_BINDING_KEY,
        },
        async (args) => {
          const binding = bindingCommand(args);
          if (binding) return binding;
          const operation = dockerOperation(args);
          if (operation[0] === "image" && operation[1] === "inspect" && args.at(-1) === TAG) {
            return { stdout: imageInspection(), stderr: "" };
          }
          if (operation[0] === "image" && operation[1] === "inspect") {
            return { stdout: deletionInspection([TAG, "customer/retained:latest"]), stderr: "" };
          }
          if (operation[0] === "image" && operation[1] === "rm") removeCalled = true;
          return { stdout: "", stderr: "" };
        },
      ),
    ).rejects.toThrow("shared repository reference");
    expect(removeCalled).toBe(false);
  });
});
