import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { testSettings } from "@opengeni/testing";
import {
  ChannelAPartialMutationError,
  RoutingMutationOutcomeUnknownError,
  SandboxChannelAService,
  type ChannelASession,
} from "@opengeni/runtime/sandbox";
import { createSandboxClientForBackend } from "@opengeni/runtime";
import {
  ConnectorAttachmentMaterializationError,
  connectorAttachmentImportOperationId,
  connectorAttachmentSandboxPath,
  materializeConnectorAttachmentsInChannel,
} from "../src/activities/connector-attachments";

setDefaultTimeout(60_000);

type LiveLocalSession = ChannelASession & {
  closed: boolean;
  state: { workspaceRootPath: string };
  close: () => Promise<void>;
};

const liveSessions: LiveLocalSession[] = [];

afterEach(async () => {
  for (const session of liveSessions.splice(0)) {
    if (!session.closed) await session.close().catch(() => undefined);
  }
});

async function makeBox(): Promise<{ session: LiveLocalSession; root: string }> {
  const settings = testSettings({ sandboxBackend: "local", webSearchEnabled: false });
  const client = createSandboxClientForBackend("local", settings) as unknown as {
    create: (manifest?: unknown) => Promise<LiveLocalSession>;
  };
  const session = await client.create({});
  liveSessions.push(session);
  return { session, root: session.state.workspaceRootPath };
}

function withPlacementPrivateStaging(session: LiveLocalSession): {
  session: ChannelASession;
  commands: string[];
  staged: Array<{ path: string; content: string }>;
} {
  const commands: string[] = [];
  const staged: Array<{ path: string; content: string }> = [];
  const wrapped = new Proxy(session as ChannelASession, {
    get(target, property, receiver) {
      if (property === "writePlacementPrivate") {
        return async (args: {
          path: string;
          content: string | Uint8Array;
          createParents?: boolean;
        }) => {
          if (args.createParents) mkdirSync(dirname(args.path), { recursive: true, mode: 0o700 });
          const content =
            typeof args.content === "string"
              ? args.content
              : Buffer.from(args.content).toString("utf8");
          staged.push({ path: args.path, content });
          await Bun.write(args.path, args.content);
          chmodSync(args.path, 0o600);
        };
      }
      if (property === "deletePlacementPrivate") {
        return async (path: string) => rmSync(path, { force: true });
      }
      if (property === "exec" || property === "execCommand") {
        const method = Reflect.get(target, property, target) as
          | ((args: { cmd: string }) => Promise<unknown>)
          | undefined;
        if (!method) return undefined;
        return async (args: { cmd: string }) => {
          commands.push(args.cmd);
          return await method.call(target, args);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { session: wrapped, commands, staged };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const fixtures = [
  {
    fileName: "binary.bin",
    mediaType: "application/octet-stream",
    bytes: Uint8Array.from([0, 255, 1, 2, 128, 10]),
  },
  {
    fileName: "utf8.txt",
    mediaType: "text/plain; charset=utf-8",
    bytes: new TextEncoder().encode("Hei, 世界 🌍\n"),
  },
  {
    fileName: "pixel.png",
    mediaType: "image/png",
    bytes: Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x49, 0x45, 0x4e, 0x44,
    ]),
  },
  {
    fileName: "document.pdf",
    mediaType: "application/pdf",
    bytes: new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n"),
  },
  {
    fileName: "change.patch",
    mediaType: "text/x-diff",
    bytes: new TextEncoder().encode("--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n"),
  },
  {
    fileName: "empty.dat",
    mediaType: "application/octet-stream",
    bytes: new Uint8Array(0),
  },
  {
    fileName: "large.bin",
    mediaType: "application/octet-stream",
    bytes: Uint8Array.from({ length: 2 * 1024 * 1024 + 17 }, (_, index) => index % 251),
  },
] as const;

describe("connector attachment sandbox materialization", () => {
  test("streams exact fixture bytes, preserves metadata, hides URLs, and replays by hash", async () => {
    const { session, root } = await makeBox();
    const placement = withPlacementPrivateStaging(session);
    const requests = new Map<string, number>();
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const index = Number(new URL(request.url).pathname.slice(1));
        const fixture = fixtures[index];
        if (!fixture) return new Response("missing", { status: 404 });
        requests.set(fixture.fileName, (requests.get(fixture.fileName) ?? 0) + 1);
        return new Response(fixture.bytes, {
          headers: { "content-type": fixture.mediaType },
        });
      },
    });
    const events: Array<{ type: string; payload: unknown }> = [];
    const channel = new SandboxChannelAService({
      session: placement.session,
      workspaceRoot: root,
      emit: async (batch) => events.push(...batch),
    });
    let providerAuthorizations = 0;
    const request = {
      serverId: "example-connector",
      toolName: "download_attachment",
      operationId: "11111111-1111-4111-8111-111111111111",
      connectionId: "22222222-2222-4222-8222-222222222222",
      attachments: fixtures.map((fixture, index) => ({
        providerAttachmentId: {
          provider: "example",
          kind: "attachment" as const,
          value: `provider-file-${index}`,
        },
        fileName: fixture.fileName,
        mediaType: fixture.mediaType,
        byteSize: fixture.bytes.byteLength,
        contentSha256: sha256(fixture.bytes),
        source: {
          url: `${server.url}${index}?signature=private-${index}`,
          expiresAt: "2030-01-02T03:04:05.000Z",
        },
      })),
      authorizeProviderRequest: async () => {
        providerAuthorizations += 1;
        return true;
      },
    };
    let mutationRuns = 0;
    const options = {
      runMutation: async <T>(mutation: () => Promise<T>) => {
        mutationRuns += 1;
        return await mutation();
      },
    };
    try {
      const first = await materializeConnectorAttachmentsInChannel(channel, request, options);
      expect(first.attachments).toHaveLength(fixtures.length);
      for (const [index, fixture] of fixtures.entries()) {
        const receipt = first.attachments[index]!;
        expect(receipt).toMatchObject({
          fileName: fixture.fileName,
          mediaType: fixture.mediaType,
          byteSize: fixture.bytes.byteLength,
          contentSha256: sha256(fixture.bytes),
        });
        expect(readFileSync(`${root}/${receipt.sandboxPath}`)).toEqual(Buffer.from(fixture.bytes));
        expect(requests.get(fixture.fileName)).toBe(1);
      }
      const serialized = JSON.stringify(first);
      expect(serialized).not.toContain("signature=private");
      expect(placement.commands.join("\n")).not.toContain("signature=private");
      expect(placement.staged).toHaveLength(fixtures.length);
      expect(placement.staged.every((entry) => entry.content.includes("signature=private"))).toBe(
        true,
      );
      expect(placement.staged.every((entry) => !existsSync(entry.path))).toBe(true);
      expect(events).toHaveLength(fixtures.length);
      expect(
        events.every((event) =>
          (event.payload as { changes?: Array<{ isDir?: boolean }> }).changes?.every(
            (change) => change.isDir === false,
          ),
        ),
      ).toBe(true);
      const firstRevision = channel.currentRevision();
      const firstEvents = structuredClone(events);
      const commandsBeforeReplay = placement.commands.length;

      const replay = await materializeConnectorAttachmentsInChannel(channel, request, options);
      expect(replay).toEqual(first);
      expect(mutationRuns).toBe(1);
      expect(providerAuthorizations).toBe(fixtures.length);
      for (const fixture of fixtures) expect(requests.get(fixture.fileName)).toBe(1);
      expect(channel.currentRevision()).toBe(firstRevision);
      expect(events).toEqual(firstEvents);
      const replayCommands = placement.commands.slice(commandsBeforeReplay).join("\n");
      expect(replayCommands).not.toContain("mkdir -p");
      expect(replayCommands).not.toContain("__OPENGENI_WORKSPACE_IMPORT_");
    } finally {
      server.stop(true);
    }
  });

  test("derives stable confined paths and UUID import identities", () => {
    const request = {
      serverId: "example-connector",
      toolName: "download_attachment",
      operationId: "11111111-1111-4111-8111-111111111111",
      connectionId: "22222222-2222-4222-8222-222222222222",
    };
    const attachment = {
      providerAttachmentId: {
        provider: "example",
        kind: "attachment" as const,
        value: "provider-file-1",
      },
      fileName: "payload.bin",
      mediaType: "application/octet-stream",
      byteSize: 0,
      contentSha256: sha256(new Uint8Array(0)),
      source: {
        url: "https://files.example.test/private",
        expiresAt: "2030-01-02T03:04:05.000Z",
      },
    };
    const path = connectorAttachmentSandboxPath(request, attachment);
    expect(path).toMatch(
      /^\.opengeni\/connector-attachments\/example\/[0-9a-f]{32}\/payload\.bin$/,
    );
    expect(connectorAttachmentSandboxPath(request, attachment)).toBe(path);
    const operation = connectorAttachmentImportOperationId(request, attachment, 0);
    expect(operation).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(connectorAttachmentImportOperationId(request, attachment, 0)).toBe(operation);
  });

  test("fences every attachment source and stops before the next revoked fetch", async () => {
    let authorizations = 0;
    let imports = 0;
    const attachments = ["one", "two"].map((value) => ({
      providerAttachmentId: {
        provider: "example",
        kind: "attachment" as const,
        value,
      },
      fileName: `${value}.txt`,
      mediaType: "text/plain",
      byteSize: value.length,
      contentSha256: sha256(new TextEncoder().encode(value)),
      source: {
        url: `https://files.example.test/${value}`,
        expiresAt: "2030-01-02T03:04:05.000Z",
      },
    }));

    await expect(
      materializeConnectorAttachmentsInChannel(
        {
          async inspectWorkspaceFiles() {
            return null;
          },
          async importWorkspaceFiles() {
            imports += 1;
            return [
              {
                destinationPath: ".opengeni/connector-attachments/example/one.txt",
                sizeBytes: 3,
                sha256: sha256(new TextEncoder().encode("one")),
              },
            ];
          },
        },
        {
          serverId: "example-connector",
          toolName: "download_attachment",
          operationId: "11111111-1111-4111-8111-111111111111",
          connectionId: "22222222-2222-4222-8222-222222222222",
          attachments,
          authorizeProviderRequest: async () => {
            authorizations += 1;
            return authorizations === 1;
          },
        },
      ),
    ).rejects.toBeInstanceOf(ChannelAPartialMutationError);
    expect(authorizations).toBe(2);
    expect(imports).toBe(1);
  });

  test("preserves routed mutation outcome-unknown", async () => {
    const uncertain = new RoutingMutationOutcomeUnknownError(
      "importWorkspaceFiles",
      "synthetic uncertain connector attachment batch",
    );
    const request = {
      serverId: "example-connector",
      toolName: "download_attachment",
      operationId: "11111111-1111-4111-8111-111111111111",
      connectionId: "22222222-2222-4222-8222-222222222222",
      attachments: [],
    };
    await expect(
      materializeConnectorAttachmentsInChannel(
        {
          async inspectWorkspaceFiles() {
            return null;
          },
          async importWorkspaceFiles() {
            throw uncertain;
          },
        },
        request,
      ),
    ).rejects.toBe(uncertain);
  });

  test("preserves a known partial workspace mutation for the outer settlement owner", async () => {
    const partial = new ChannelAPartialMutationError("first file committed", {
      cause: new Error("second file failed integrity"),
    });
    const request = {
      serverId: "example-connector",
      toolName: "download_attachment",
      operationId: "11111111-1111-4111-8111-111111111111",
      connectionId: "22222222-2222-4222-8222-222222222222",
      attachments: [],
    };
    await expect(
      materializeConnectorAttachmentsInChannel(
        {
          async inspectWorkspaceFiles() {
            return null;
          },
          async importWorkspaceFiles() {
            throw partial;
          },
        },
        request,
      ),
    ).rejects.toBe(partial);
  });

  test("reports a real two-file integrity failure as partial after preserving the first exact file", async () => {
    const { session, root } = await makeBox();
    const placement = withPlacementPrivateStaging(session);
    const firstBytes = new TextEncoder().encode("first exact attachment");
    const secondBytes = new TextEncoder().encode("second corrupt attachment");
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        return new Response(new URL(request.url).pathname === "/first" ? firstBytes : secondBytes);
      },
    });
    const channel = new SandboxChannelAService({
      session: placement.session,
      workspaceRoot: root,
    });
    const request = {
      serverId: "example-connector",
      toolName: "download_attachment",
      operationId: "11111111-1111-4111-8111-111111111111",
      connectionId: "22222222-2222-4222-8222-222222222222",
      attachments: [
        {
          providerAttachmentId: {
            provider: "example",
            kind: "attachment" as const,
            value: "provider-file-first",
          },
          fileName: "first.bin",
          mediaType: "application/octet-stream",
          byteSize: firstBytes.byteLength,
          contentSha256: sha256(firstBytes),
          source: {
            url: `${server.url}first?signature=private-first`,
            expiresAt: "2030-01-02T03:04:05.000Z",
          },
        },
        {
          providerAttachmentId: {
            provider: "example",
            kind: "attachment" as const,
            value: "provider-file-second",
          },
          fileName: "second.bin",
          mediaType: "application/octet-stream",
          byteSize: secondBytes.byteLength,
          contentSha256: "0".repeat(64),
          source: {
            url: `${server.url}second?signature=private-second`,
            expiresAt: "2030-01-02T03:04:05.000Z",
          },
        },
      ],
    };
    const firstPath = connectorAttachmentSandboxPath(request, request.attachments[0]);
    const secondPath = connectorAttachmentSandboxPath(request, request.attachments[1]);
    try {
      await expect(
        materializeConnectorAttachmentsInChannel(channel, request),
      ).rejects.toBeInstanceOf(ChannelAPartialMutationError);
      expect(readFileSync(`${root}/${firstPath}`)).toEqual(Buffer.from(firstBytes));
      expect(existsSync(`${root}/${secondPath}`)).toBe(false);
      expect(channel.currentRevision()).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test.each([
    ["corrupt bytes", false],
    ["expired source", true],
  ])("fails closed for %s without publishing a target", async (_label, expired) => {
    const { session, root } = await makeBox();
    const placement = withPlacementPrivateStaging(session);
    const bytes = new TextEncoder().encode("provider bytes");
    const server = Bun.serve({ port: 0, fetch: () => new Response(bytes) });
    const channel = new SandboxChannelAService({
      session: placement.session,
      workspaceRoot: root,
    });
    const request = {
      serverId: "example-connector",
      toolName: "download_attachment",
      operationId: "11111111-1111-4111-8111-111111111111",
      connectionId: "22222222-2222-4222-8222-222222222222",
      attachments: [
        {
          providerAttachmentId: {
            provider: "example",
            kind: "attachment" as const,
            value: "provider-file-failure",
          },
          fileName: "failure.bin",
          mediaType: "application/octet-stream",
          byteSize: bytes.byteLength,
          contentSha256: "0".repeat(64),
          source: {
            url: `${server.url}?signature=private-failure`,
            expiresAt: expired ? "2026-08-13T00:00:00.000Z" : "2030-01-02T03:04:05.000Z",
          },
        },
      ],
    };
    const target = connectorAttachmentSandboxPath(request, request.attachments[0]);
    try {
      await expect(
        materializeConnectorAttachmentsInChannel(channel, request),
      ).rejects.toBeInstanceOf(ConnectorAttachmentMaterializationError);
      expect(existsSync(`${root}/${target}`)).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
