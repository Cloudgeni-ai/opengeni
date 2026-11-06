import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { GmailRestMcpServer, type GmailRestMcpServerOptions } from "../src/gmail-rest-mcp";

function fixture(read: NonNullable<GmailRestMcpServerOptions["readGmailFile"]>) {
  const requests: unknown[] = [];
  const server = new GmailRestMcpServer({
    workspaceId: "ws",
    subjectId: "human",
    serverId: "gmail",
    connectionRef: {
      providerDomain: "gmailmcp.googleapis.com",
      kind: "oauth2",
      subjectScope: "subject",
    },
    resolveCredential: async () => ({
      status: "ok",
      headers: { authorization: "Bearer fixture" },
      connectionId: "fixture",
    }),
    readGmailFile: read,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "draft", message: { id: "message" } });
    },
  });
  return { server, requests };
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const attachment = (path: string, sha256: string) => ({
  filename: path.split("/").pop(),
  file: { path, sha256 },
});

test("mixed inline and file input decodes a large inline payload only once", async () => {
  const encoded = Buffer.alloc(4 * 1024 * 1024, 97).toString("base64");
  const bytes = Buffer.from("small file");
  const original = Buffer.from;
  let decodes = 0;
  const spy = spyOn(Buffer, "from").mockImplementation(((...args: unknown[]) => {
    if (args[0] === encoded && args[1] === "base64") decodes++;
    return Reflect.apply(original, Buffer, args);
  }) as typeof Buffer.from);
  try {
    const { server } = fixture(async () => bytes);
    const result = (await server.callToolResult("create_draft", {
      attachments: [
        { content: encoded, filename: "large.txt" },
        attachment("/workspace/a", digest(bytes)),
      ],
    })) as { isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(decodes).toBe(1);
  } finally {
    spy.mockRestore();
  }
});

test("invalid later attachment metadata starts no file reads", async () => {
  const bytes = Buffer.from("small");
  let reads = 0;
  const { server, requests } = fixture(async () => {
    reads++;
    return bytes;
  });
  const result = (await server.callToolResult("create_draft", {
    attachments: [attachment("/workspace/a", digest(bytes)), attachment("/workspace/b", "invalid")],
  })) as { isError?: boolean };
  expect(result.isError).toBe(true);
  expect(requests).toHaveLength(0);
  expect(reads).toBe(0);
});

test("duplicate exact file references read once but preserve every attachment", async () => {
  const bytes = Buffer.from("same accepted bytes");
  let reads = 0;
  const { server, requests } = fixture(async () => {
    reads++;
    return bytes;
  });
  const result = (await server.callToolResult("create_draft", {
    attachments: Array.from({ length: 10 }, (_, i) => ({
      ...attachment("/workspace/a", digest(bytes)),
      filename: `copy-${i}.txt`,
    })),
  })) as { isError?: boolean };
  expect(result.isError).not.toBe(true);
  expect(reads).toBe(1);
  const mime = Buffer.from(
    (requests[0] as { message: { raw: string } }).message.raw,
    "base64url",
  ).toString();
  for (let i = 0; i < 10; i++) expect(mime).toContain(`copy-${i}.txt`);
});

test("100 distinct small files retain parallel reads and exact attachment order", async () => {
  const bytes = Buffer.from("small accepted bytes");
  let active = 0,
    peak = 0,
    reads = 0;
  const { server, requests } = fixture(async () => {
    reads++;
    peak = Math.max(peak, ++active);
    await Bun.sleep(2);
    active--;
    return bytes;
  });
  const result = (await server.callToolResult("create_draft", {
    attachments: Array.from({ length: 100 }, (_, i) =>
      attachment(`/workspace/item-${i}.txt`, digest(bytes)),
    ),
  })) as { isError?: boolean };
  expect(result.isError).not.toBe(true);
  expect(reads).toBe(100);
  expect(peak).toBe(100);
  expect(active).toBe(0);
  const mime = Buffer.from(
    (requests[0] as { message: { raw: string } }).message.raw,
    "base64url",
  ).toString();
  let previous = -1;
  for (let i = 0; i < 100; i++) {
    const position = mime.indexOf(`item-${i}.txt`);
    expect(position).toBeGreaterThan(previous);
    previous = position;
  }
});

test("sharing exact reads never shares cache across separate draft operations", async () => {
  const bytes = Buffer.from("same content");
  let reads = 0;
  const { server } = fixture(async () => {
    reads++;
    return bytes;
  });
  const args = {
    attachments: [
      attachment("/workspace/a", digest(bytes)),
      attachment("/workspace/a", digest(bytes)),
    ],
  };
  await server.callToolResult("create_draft", args);
  await server.callToolResult("create_draft", args);
  expect(reads).toBe(2);
});

test("duplicate occurrences still count separately toward the aggregate limit", async () => {
  const bytes = Buffer.alloc(13 * 1024 * 1024, 97);
  let reads = 0;
  const { server, requests } = fixture(async () => {
    reads++;
    return bytes;
  });
  const result = (await server.callToolResult("create_draft", {
    attachments: Array.from({ length: 2 }, () => attachment("/workspace/a", digest(bytes))),
  })) as { isError?: boolean };
  expect(result.isError).toBe(true);
  expect(reads).toBe(1);
  expect(requests).toHaveLength(0);
});

test("failed file input joins an already-started sibling before returning", async () => {
  const bytes = Buffer.from("sibling");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0,
    finished = false;
  const { server, requests } = fixture(async ({ path }) => {
    started++;
    if (path.endsWith("failed")) throw new Error("fixture unavailable");
    await gate;
    return bytes;
  });
  const pending = server
    .callToolResult("create_draft", {
      attachments: [
        attachment("/workspace/failed", digest(bytes)),
        attachment("/workspace/sibling", digest(bytes)),
      ],
    })
    .finally(() => {
      finished = true;
    });
  try {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(started).toBe(2);
    expect(finished).toBe(false);
    expect(requests).toHaveLength(0);
  } finally {
    release();
    await pending;
  }
  expect(finished).toBe(true);
  expect(requests).toHaveLength(0);
});
