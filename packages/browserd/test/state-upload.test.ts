import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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
      await withUploadServer(201, async (url, received) => {
        await uploadBrowserStateArtifact(artifact, authority(url), { now: () => now });
        const request = await received;
        expect(request.method).toBe("PUT");
        expect(request.headers["content-type"]).toBe(BROWSER_STATE_ARTIFACT_CONTENT_TYPE);
        expect(request.headers["x-ms-blob-type"]).toBe("BlockBlob");
        expect(request.headers["content-length"]).toBe("5");
        expect(request.body).toEqual(Buffer.from([0, 1, 2, 3, 255]));
      });
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
      const unavailable = await unavailableUrl();
      const attempts = [
        () => uploadBrowserStateArtifact(artifact, authority(unavailable), { now: () => now }),
        () =>
          withUploadServer(503, (url) =>
            uploadBrowserStateArtifact(artifact, authority(url), { now: () => now }),
          ),
      ];
      for (const attempt of attempts) {
        try {
          await attempt();
          throw new Error("expected upload failure");
        } catch (error) {
          expect(error).toBeInstanceOf(BrowserStateUploadError);
          expect((error as BrowserStateUploadError).outcomeUnknown).toBe(true);
        }
      }
    });
  });

  test("does not follow storage redirects with the signed upload grant", async () => {
    await withDirectory(async (directory) => {
      const artifact = join(directory, "profile.ogbs");
      await writeFile(artifact, "encrypted");
      await withRedirectUploadServer(async (url, redirectedRequests) => {
        try {
          await uploadBrowserStateArtifact(artifact, authority(url), { now: () => now });
          throw new Error("expected redirect rejection");
        } catch (error) {
          expect(error).toBeInstanceOf(BrowserStateUploadError);
          expect((error as Error).message).toContain("HTTP 307");
        }
        expect(redirectedRequests()).toBe(0);
      });
    });
  });

  test("does not touch a successful storage response body", async () => {
    await withDirectory(async (directory) => {
      const artifact = join(directory, "profile.ogbs");
      await writeFile(artifact, "encrypted");
      await withUploadServer(
        200,
        async (url) => {
          await uploadBrowserStateArtifact(artifact, authority(url), { now: () => now });
        },
        {
          leaveResponseOpen: true,
        },
      );
    });
  });
});

function authority(url = "https://state.test/object?signature=private") {
  return {
    url,
    requiredHeaders: {
      "content-type": BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
      "x-ms-blob-type": "BlockBlob",
    },
    expiresAt: "2026-08-10T12:05:00.000Z",
  };
}

type ReceivedUpload = {
  method: string | undefined;
  headers: IncomingMessage["headers"];
  body: Buffer;
};

async function withUploadServer<T>(
  status: number,
  run: (url: string, received: Promise<ReceivedUpload>) => Promise<T>,
  options: { leaveResponseOpen?: boolean } = {},
): Promise<T> {
  let resolveUpload!: (upload: ReceivedUpload) => void;
  const received = new Promise<ReceivedUpload>((resolve) => {
    resolveUpload = resolve;
  });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    resolveUpload({
      method: request.method,
      headers: request.headers,
      body: Buffer.concat(chunks),
    });
    response.writeHead(status);
    response.flushHeaders();
    if (!options.leaveResponseOpen) response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}/object?signature=private`, received);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}

async function unavailableUrl(): Promise<string> {
  const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return `http://127.0.0.1:${address.port}/closed`;
}

async function withRedirectUploadServer<T>(
  run: (url: string, redirectedRequests: () => number) => Promise<T>,
): Promise<T> {
  let redirectedRequests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the request before returning the storage redirect.
    }
    if (request.url === "/redirect-target") {
      redirectedRequests += 1;
      response.writeHead(201).end();
      return;
    }
    const address = server.address() as AddressInfo;
    response.writeHead(307, {
      location: `http://127.0.0.1:${address.port}/redirect-target`,
    });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    return await run(
      `http://127.0.0.1:${address.port}/object?signature=private`,
      () => redirectedRequests,
    );
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "opengeni-state-upload-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
