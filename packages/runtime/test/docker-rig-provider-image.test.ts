import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { buildDockerImmutableImage } from "../src/sandbox/providers/docker";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const TAG = `opengeni-rig-provider:${REQUEST_ID}`;
const CONTAINER_ID = "a".repeat(64);
const IMAGE_ID = `sha256:${"b".repeat(64)}`;

function imageInspection(imageId = IMAGE_ID, requestId = REQUEST_ID): string {
  return `${imageId}\n1\n${requestId}\n`;
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
        if (args[0] === "image" && args[1] === "inspect") {
          imageInspections += 1;
          if (imageInspections === 1) {
            throw Object.assign(new Error("missing image"), {
              stderr: `Error: No such image: ${TAG}\n`,
            });
          }
          return { stdout: imageInspection(), stderr: "" };
        }
        if (args[0] === "inspect") {
          return { stdout: `${CONTAINER_ID}\ntrue\n`, stderr: "" };
        }
        if (args[0] === "commit") {
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
      providerBindingKey: null,
      providerBinding: null,
    });
    const commit = calls.find((args) => args[0] === "commit");
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
        return { stdout: imageInspection(), stderr: "" };
      },
    );

    expect(result.imageId).toBe(IMAGE_ID);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual(["image", "inspect"]);
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
        async () => ({ stdout: imageInspection(IMAGE_ID, crypto.randomUUID()), stderr: "" }),
      ),
    ).rejects.toThrow("owned by another build protocol");
  });
});
