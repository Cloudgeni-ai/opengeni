import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
  BrowserStateUploadError,
  uploadBrowserStateArtifact,
  validateUploadAuthority,
} from "../src";

const now = new Date("2026-08-10T12:00:00.000Z");

describe("browser state artifact upload", () => {
  test("validates the narrow grant and streams the encrypted artifact once", async () => {
    await withDirectory(async (directory) => {
      const artifact = join(directory, "profile.ogbs");
      await writeFile(artifact, Buffer.from([0, 1, 2, 3, 255]));
      let calls = 0;
      const fetchStub = (async (input, init) => {
        calls += 1;
        expect(String(input)).toBe("https://state.test/object?signature=private");
        expect(init?.method).toBe("PUT");
        expect(init?.redirect).toBe("error");
        expect(init?.headers).toEqual({
          "content-type": BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
          "x-ms-blob-type": "BlockBlob",
        });
        expect(Buffer.from(await new Response(init?.body).arrayBuffer())).toEqual(
          Buffer.from([0, 1, 2, 3, 255]),
        );
        return new Response(null, { status: 201 });
      }) as typeof fetch;

      await uploadBrowserStateArtifact(artifact, authority(), {
        fetch: fetchStub,
        now: () => now,
      });
      expect(calls).toBe(1);
    });
  });

  test("rejects expired, credentialed, redirected, or overpowered grants before dispatch", async () => {
    expect(() =>
      validateUploadAuthority({ ...authority(), expiresAt: now.toISOString() }, now),
    ).toThrow("expired");
    expect(() =>
      validateUploadAuthority(
        { ...authority(), url: "https://user:secret@state.test/object" },
        now,
      ),
    ).toThrow("URL is invalid");
    expect(() =>
      validateUploadAuthority(
        {
          ...authority(),
          requiredHeaders: {
            ...authority().requiredHeaders,
            authorization: "Bearer broader-than-needed",
          },
        },
        now,
      ),
    ).toThrow("header is invalid");
    expect(() =>
      validateUploadAuthority(
        {
          ...authority(),
          requiredHeaders: {
            "Content-Type": BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
          },
        },
        now,
      ),
    ).toThrow("header is invalid");
  });

  test("classifies every post-dispatch transport result without success as outcome-unknown", async () => {
    await withDirectory(async (directory) => {
      const artifact = join(directory, "profile.ogbs");
      await writeFile(artifact, "encrypted");
      for (const fetchStub of [
        (async () => {
          throw new Error("connection reset");
        }) as unknown as typeof fetch,
        (async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
      ]) {
        try {
          await uploadBrowserStateArtifact(artifact, authority(), {
            fetch: fetchStub,
            now: () => now,
          });
          throw new Error("expected upload failure");
        } catch (error) {
          expect(error).toBeInstanceOf(BrowserStateUploadError);
          expect((error as BrowserStateUploadError).outcomeUnknown).toBe(true);
        }
      }
    });
  });
});

function authority() {
  return {
    url: "https://state.test/object?signature=private",
    requiredHeaders: {
      "content-type": BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
      "x-ms-blob-type": "BlockBlob",
    },
    expiresAt: "2026-08-10T12:05:00.000Z",
  };
}

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "opengeni-state-upload-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
