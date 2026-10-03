import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import PostalMime from "postal-mime";
import { RoutingMutationOutcomeUnknownError } from "../src/sandbox/routing/routing-session";
import { PrefixedMcpServer, runRecoverableMcpOperation, prepareAgentTools } from "../src/index";
import { testSettings } from "@opengeni/testing";
import {
  GmailRestMcpServer,
  GMAIL_REST_MCP_TOOLS,
  gmailRestToolIsMutation,
  type GmailRestMcpServerOptions,
  gmailRestResultOutcome,
} from "../src/gmail-rest-mcp";

const operationId = "12345678-1234-4123-8123-123456789abc";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const raw = Buffer.from("To: owner@example.test\r\nSubject: Draft\r\n\r\nOriginal body");
const b64 = (bytes: string | Uint8Array) => Buffer.from(bytes).toString("base64url");
function make(fetchImpl: typeof fetch, overrides: Partial<GmailRestMcpServerOptions> = {}) {
  return new GmailRestMcpServer({
    workspaceId: "workspace-test",
    serverId: "gmail-test",
    subjectId: "subject-test",
    connectionRef: {
      providerDomain: "gmailmcp.googleapis.com",
      kind: "oauth2",
      subjectScope: "subject",
    },
    resolveCredential: async () => ({
      status: "ok",
      headers: { authorization: "Bearer synthetic-token" },
      connectionId: "connection-test",
    }),
    fetchImpl,
    ...overrides,
  });
}
async function value(server: GmailRestMcpServer, name: string, args: Record<string, unknown> = {}) {
  const result = await server.callToolResult(name, args, { opengeniOperationId: operationId });
  expect(result.isError).not.toBe(true);
  return result.structuredContent;
}

describe("Gmail complete mailbox operations", () => {
  test("message search returns only matching IDs and preserves query, labels and cursor", async () => {
    const requests: URL[] = [];
    const server = make(async (input) => {
      const url = new URL(input.toString());
      requests.push(url);
      if (url.pathname.endsWith("/messages"))
        return Response.json({
          messages: [{ id: "matching-1" }],
          nextPageToken: "opaque-next",
          resultSizeEstimate: 1,
        });
      expect(url.pathname).toEndWith("/messages/matching-1");
      return Response.json({
        id: "matching-1",
        threadId: "mixed-thread",
        payload: { headers: [{ name: "From", value: "Alice <alice@example.test>" }] },
      });
    });
    const page = await value(server, "search_messages", {
      query: "from:alice@example.test",
      labelIds: ["INBOX"],
      includeSpamTrash: true,
      pageToken: "opaque-before",
      pageSize: 1,
    });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0].id).toBe("matching-1");
    expect(page.nextPageToken).toBe("opaque-next");
    expect(requests[0]!.searchParams.get("q")).toBe("from:alice@example.test");
    expect(requests[0]!.searchParams.getAll("labelIds")).toEqual(["INBOX"]);
    expect(requests[0]!.searchParams.get("includeSpamTrash")).toBe("true");
    expect(requests[0]!.searchParams.get("pageToken")).toBe("opaque-before");
  });

  test("draft create, get, replacement, stale review rejection and delete retain correct identities", async () => {
    let saved = raw,
      deleted = false,
      sent = 0;
    const server = make(async (input, init) => {
      const url = new URL(input.toString()),
        method = init?.method ?? "GET";
      if (method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/drafts/send")) {
        sent++;
        return Response.json({ id: "sent-test" });
      }
      if (method === "POST" || method === "PUT") {
        saved = Buffer.from(JSON.parse(String(init?.body)).message.raw, "base64url");
        return Response.json({ id: "draft-test", message: { id: "new-message-test" } });
      }
      return Response.json({
        id: "draft-test",
        message:
          url.searchParams.get("format") === "raw"
            ? { id: "message-test", raw: b64(saved) }
            : {
                id: "message-test",
                payload: { mimeType: "text/plain", body: { data: b64("Original body") } },
              },
      });
    });
    const created = await value(server, "create_draft", {
      to: ["owner@example.test"],
      body: "original",
    });
    expect(created.draftId).toBe("draft-test");
    expect(created.messageId).toBe("new-message-test");
    const review = await value(server, "get_draft", { draftId: "draft-test" });
    expect(review.messageId).toBe("message-test");
    expect(review.contentSha256).toBe(digest(saved));
    await value(server, "update_draft", {
      draftId: "draft-test",
      body: "replacement",
      expectedContentSha256: review.contentSha256,
    });
    expect((await PostalMime.parse(saved)).text?.trim()).toBe("replacement");
    const stale = await server.callToolResult("send_draft", {
      draftId: "draft-test",
      expectedContentSha256: review.contentSha256,
    });
    expect(stale.isError).toBe(true);
    expect(sent).toBe(0);
    await value(server, "send_draft", {
      draftId: "draft-test",
      expectedContentSha256: digest(saved),
    });
    expect(sent).toBe(1);
    await value(server, "delete_draft", { draftId: "draft-test" });
    expect(deleted).toBe(true);
  });

  test("label CRUD, atomic organization, batches and trash/restore use reviewed endpoints", async () => {
    const calls: Array<{ url: URL; method: string; body: any }> = [];
    const server = make(async (input, init) => {
      const call = {
        url: new URL(input.toString()),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      calls.push(call);
      return call.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ id: "Label_test", labelIds: ["INBOX"] });
    });
    await value(server, "create_label", { name: "Temporary" });
    await value(server, "get_label", { labelId: "Label_test" });
    await value(server, "update_label", { labelId: "Label_test", name: "Renamed" });
    await value(server, "update_label", { labelId: "Label_test", name: "Replaced", replace: true });
    await value(server, "modify_message", {
      messageId: "message-test",
      addLabelIds: ["STARRED"],
      removeLabelIds: ["UNREAD", "INBOX"],
    });
    await value(server, "modify_thread", {
      threadId: "thread-test",
      addLabelIds: ["SPAM"],
      removeLabelIds: ["INBOX"],
    });
    await value(server, "batch_modify_messages", {
      messageIds: ["a", "b"],
      addLabelIds: ["Label_test"],
    });
    for (const kind of ["message", "thread"])
      for (const action of ["trash", "restore"])
        await value(server, `${action}_${kind}`, { [`${kind}Id`]: "test-id" });
    await value(server, "delete_label", { labelId: "Label_test" });
    expect(calls.map((call) => [call.method, call.url.pathname.split("/me/")[1]])).toEqual([
      ["POST", "labels"],
      ["GET", "labels/Label_test"],
      ["PATCH", "labels/Label_test"],
      ["PUT", "labels/Label_test"],
      ["POST", "messages/message-test/modify"],
      ["POST", "threads/thread-test/modify"],
      ["POST", "messages/batchModify"],
      ["POST", "messages/test-id/trash"],
      ["POST", "messages/test-id/untrash"],
      ["POST", "threads/test-id/trash"],
      ["POST", "threads/test-id/untrash"],
      ["DELETE", "labels/Label_test"],
    ]);
    expect(calls[4]!.body).toEqual({
      addLabelIds: ["STARRED"],
      removeLabelIds: ["UNREAD", "INBOX"],
    });
    expect(calls[6]!.body.ids).toEqual(["a", "b"]);
  });

  test("body delivery handles external data, quoted names, charsets, inline metadata and exact date", async () => {
    const server = make(async (input) =>
      new URL(input.toString()).pathname.includes("/attachments/")
        ? Response.json({ data: b64(Buffer.from([0x63, 0x61, 0x66, 0xe9])), size: 4 })
        : Response.json({
            id: "mime-test",
            payload: {
              mimeType: "multipart/mixed",
              headers: [
                { name: "To", value: '"Smith, Alice" <alice@example.test>, bob@example.test' },
                { name: "Date", value: "Sat, 3 Oct 2026 20:00:00 +0200" },
              ],
              parts: [
                {
                  partId: "0",
                  mimeType: "text/plain",
                  headers: [{ name: "Content-Type", value: "text/plain; charset=iso-8859-1" }],
                  body: { attachmentId: "external-body", size: 4 },
                },
                {
                  partId: "1",
                  filename: "pixel.png",
                  mimeType: "image/png",
                  headers: [{ name: "Content-ID", value: "<pixel>" }],
                  body: { data: b64(Uint8Array.from([0, 255])), size: 2 },
                },
              ],
            },
          }),
    );
    const message = await value(server, "get_message", { messageId: "mime-test" });
    expect(message.plaintextBody).toBe("café");
    expect(message.toRecipients).toHaveLength(2);
    expect(message.toRecipients[0]).toContain("Smith, Alice");
    expect(message.dateTime).toBe("2026-10-03T18:00:00.000Z");
    expect(message.attachments[0]).toMatchObject({ partId: "1", contentId: "<pixel>" });
    expect(message.mimeParts.map((part: any) => part.partId)).toEqual(["", "0", "1"]);
  });

  for (const inline of [false, true])
    test(`exact binary download ${inline ? "inline" : "external"} keeps bytes private and checks authority`, async () => {
      const bytes = Buffer.from([0, 255, 128, 10]);
      let captured: Uint8Array | undefined;
      const server = make(
        async (input) =>
          new URL(input.toString()).pathname.includes("/attachments/")
            ? Response.json({ data: b64(bytes), size: bytes.length })
            : Response.json({
                id: "message-test",
                payload: {
                  parts: [
                    {
                      partId: "1",
                      filename: "../../unsafe.bin",
                      mimeType: "application/octet-stream",
                      body: {
                        size: bytes.length,
                        ...(inline ? { data: b64(bytes) } : { attachmentId: "attachment-test" }),
                      },
                    },
                  ],
                },
              }),
        {
          materializeGmailFile: async (request) => {
            expect(await request.authorizeProviderRequest()).toBe(true);
            expect(request.fileName).not.toContain("/");
            captured = request.bytes;
            return { sandboxPath: "safe/file.bin", contentSha256: digest(request.bytes) };
          },
        },
      );
      const receipt = await value(server, "download_attachment", {
        messageId: "message-test",
        partId: "1",
      });
      expect(Buffer.from(captured!)).toEqual(bytes);
      expect(receipt.contentSha256).toBe(digest(bytes));
      expect(JSON.stringify(receipt)).not.toContain(b64(bytes));
      expect(JSON.stringify(receipt)).not.toContain("synthetic-token");
    });

  test("original message downloads preserve all raw bytes, and missing filesystem fails explicitly", async () => {
    let captured: Uint8Array | undefined;
    const fetchImpl = async () => Response.json({ id: "raw-test", raw: b64(raw) });
    const server = make(fetchImpl, {
      materializeGmailFile: async (request) => {
        captured = request.bytes;
        return { fileName: request.fileName };
      },
    });
    const receipt = await value(server, "download_message", { messageId: "raw-test" });
    expect(receipt.fileName).toEndWith(".eml");
    expect(Buffer.from(captured!)).toEqual(raw);
    const unavailable = await make(fetchImpl).callToolResult(
      "download_message",
      { messageId: "raw-test" },
      { opengeniOperationId: operationId },
    );
    expect(unavailable.isError).toBe(true);
  });

  test("Unicode compose, Cc-only send, verified alias and CID attachments round-trip through an independent MIME parser", async () => {
    let encoded: Buffer | undefined;
    const bytes = Buffer.from([0, 255, 10]);
    const server = make(
      async (input, init) => {
        if (new URL(input.toString()).pathname.endsWith("/settings/sendAs"))
          return Response.json({
            sendAs: [{ sendAsEmail: "alias@example.test", verificationStatus: "accepted" }],
          });
        encoded = Buffer.from(JSON.parse(String(init?.body)).raw, "base64url");
        return Response.json({ id: "sent-test" });
      },
      {
        readGmailFile: async (request) => {
          expect(request.sha256).toBe(digest(bytes));
          return bytes;
        },
      },
    );
    await value(server, "send_message", {
      cc: ['"Smith, Alice" <alice@example.test>'],
      from: "Alias <alias@example.test>",
      subject: "Hello 世界",
      body: "plain",
      htmlBody: '<img src="cid:pixel">',
      attachments: [
        {
          file: { path: "pixel.bin", sha256: digest(bytes) },
          filename: "世界.bin",
          inline: true,
          contentId: "pixel",
        },
      ],
    });
    const parsed = await PostalMime.parse(encoded!);
    expect(parsed.subject).toBe("Hello 世界");
    expect(parsed.cc?.[0]).toMatchObject({ name: "Smith, Alice", address: "alice@example.test" });
    expect(parsed.attachments[0]?.filename).toBe("世界.bin");
    expect(parsed.attachments[0]?.contentId).toBe("<pixel>");
    expect(Buffer.from(parsed.attachments[0]!.content as ArrayBuffer)).toEqual(bytes);
  });

  test("imports never send and Calendar processing defaults off", async () => {
    const calls: Array<{ url: URL; body: any }> = [];
    const server = make(async (input, init) => {
      calls.push({ url: new URL(input.toString()), body: JSON.parse(String(init?.body)) });
      return Response.json({ id: "imported" });
    });
    await value(server, "import_message", {
      raw: b64(raw),
      internalDateSource: "dateHeader",
      labelIds: ["INBOX"],
    });
    await value(server, "insert_message", { raw: b64(raw) });
    expect(calls[0]!.url.pathname).toEndWith("/messages/import");
    expect(calls[0]!.url.searchParams.get("processForCalendar")).toBe("false");
    expect(calls[1]!.url.pathname).toEndWith("/messages/insert");
    expect(Buffer.from(calls[0]!.body.raw, "base64url")).toEqual(raw);
  });

  test("history preserves continuation and expired cursors require resync", async () => {
    const good = make(async (input) => {
      const url = new URL(input.toString());
      expect(url.searchParams.get("startHistoryId")).toBe("123");
      return Response.json({
        history: [{ id: "124", messagesAdded: [{ message: { id: "new-mail" } }] }],
        historyId: "125",
        nextPageToken: "next",
      });
    });
    expect(await value(good, "get_history", { startHistoryId: "123" })).toMatchObject({
      historyId: "125",
      nextPageToken: "next",
    });
    const expired = make(async () =>
      Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 }),
    );
    expect(await value(expired, "get_history", { startHistoryId: "123" })).toEqual({
      resyncRequired: true,
      reason: "history_cursor_expired",
    });
  });

  test("watch destination is operator-owned and settings cover every readable resource", async () => {
    const calls: URL[] = [],
      bodies: any[] = [];
    const server = make(
      async (input, init) => {
        calls.push(new URL(input.toString()));
        bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
        return Response.json({ historyId: "100", expiration: "999" });
      },
      { watchTopicName: "projects/example-project/topics/gmail-test" },
    );
    await value(server, "watch_mailbox", { labelIds: ["INBOX"], labelFilterBehavior: "include" });
    expect(bodies[0].topicName).toBe("projects/example-project/topics/gmail-test");
    await value(server, "stop_watch");
    expect(
      (await make(async () => Response.json({})).callToolResult("watch_mailbox", {})).isError,
    ).toBe(true);
    for (const resource of ["autoForwarding", "imap", "language", "pop", "vacation"])
      await value(server, "get_settings", { resource });
    for (const resource of [
      "sendAs",
      "filters",
      "forwardingAddresses",
      "smimeInfo",
      "cseIdentities",
      "cseKeypairs",
    ]) {
      await value(server, "list_settings", { resource, sendAsEmail: "owner@example.test" });
      await value(server, "get_settings", {
        resource,
        id: "opaque-id",
        sendAsEmail: "owner@example.test",
      });
    }
    expect(calls.some((url) => url.pathname.endsWith("/settings/cse/identities/opaque-id"))).toBe(
      true,
    );
    expect(
      calls.some((url) =>
        url.pathname.endsWith("/settings/sendAs/owner%40example.test/smimeInfo/opaque-id"),
      ),
    ).toBe(true);
  });

  test("all new mutation transports remain non-replayed, including unreadable success", async () => {
    for (const response of [
      () => Response.json({ error: {} }, { status: 401 }),
      () => new Response("broken JSON", { status: 200 }),
      () => {
        throw new Error("unknown");
      },
    ]) {
      let count = 0;
      const server = make(async () => {
        count++;
        return response();
      });
      await expect(server.callToolResult("create_label", { name: "Test" })).rejects.toMatchObject({
        code: 40_102,
        connectorActionOutcome: "uncertain",
      });
      expect(count).toBe(1);
    }
  });

  test("invalid inputs reject before side effects, cancellation and account changes deny reads", async () => {
    let count = 0;
    const server = make(async () => {
      count++;
      return Response.json({});
    });
    for (const [name, args] of [
      ["modify_message", { messageId: "a", addLabelIds: ["TRASH"] }],
      ["delete_label", { labelId: "INBOX" }],
      ["get_settings", { resource: "../../other" }],
      ["list_settings", { resource: "delegates" }],
      ["create_draft", { to: ["bad\r\nBcc: other@example.test"] }],
      ["search_messages", { pageSize: 51 }],
    ] as const)
      expect((await server.callToolResult(name, args)).isError).toBe(true);
    expect(count).toBe(0);
    expect(
      (await server.callToolResult("get_profile", {}, null, { signal: AbortSignal.abort() }))
        .isError,
    ).toBe(true);
    expect(count).toBe(0);
    let connection = "a";
    const changing = make(async () => Response.json({}), {
      resolveCredential: async () => ({ status: "ok", headers: {}, connectionId: connection }),
    });
    await value(changing, "get_profile");
    connection = "b";
    expect((await changing.callToolResult("get_profile", {})).isError).toBe(true);
  });

  test("catalog scope hints and mandatory approval cover every mutation", async () => {
    const catalog = await Bun.file(
      new URL("../../../data/catalog/curated.json", import.meta.url),
    ).json();
    const gmail = catalog.entries.find(
      (item: any) => item.mcpUrl === "https://gmailmcp.googleapis.com/mcp/v1",
    );
    expect(gmail.allowedTools.slice().sort()).toEqual(
      GMAIL_REST_MCP_TOOLS.map((tool) => tool.name).sort(),
    );
    expect(gmail.requireApproval.slice().sort()).toEqual(
      GMAIL_REST_MCP_TOOLS.filter((tool) => gmailRestToolIsMutation(tool.name))
        .map((tool) => tool.name)
        .sort(),
    );
    expect(gmail.scopesHint).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.modify",
    ]);
  });

  test("original message bytes exceed the old JSON limit without entering model output", async () => {
    const bytes = Buffer.alloc(9 * 1024 * 1024, 0xa5);
    let delivered = false;
    const server = make(async () => Response.json({ id: "large-test", raw: b64(bytes) }), {
      materializeGmailFile: async (request) => {
        delivered = true;
        expect(request.bytes).toEqual(bytes);
        return { attachments: [{ byteSize: bytes.length, contentSha256: digest(bytes) }] };
      },
    });
    const result = await value(server, "download_message", { messageId: "large-test" });
    expect(delivered).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(1000);
  });

  test("empty Gmail success responses and long Unicode subjects remain valid", async () => {
    let mime: Buffer | undefined;
    const server = make(async (_input, init) => {
      if (init?.method === "DELETE" || !init?.body) return new Response(null);
      const body = JSON.parse(String(init.body));
      if (body.message) mime = Buffer.from(body.message.raw, "base64url");
      return Response.json({ id: "draft-test" });
    });
    await value(server, "delete_draft", { draftId: "draft-test" });
    await value(server, "stop_watch");
    const subject = "Melding 📬 café ".repeat(30);
    await value(server, "create_draft", { to: ["owner@example.test"], subject, body: "body" });
    expect((await PostalMime.parse(mime!)).subject).toBe(subject);
    expect(
      mime!
        .toString()
        .split("\r\n")
        .every((line) => line.length <= 998),
    ).toBe(true);
  });

  test("filesystem mutation uncertainty survives the MCP boundary", async () => {
    const uncertain = new RoutingMutationOutcomeUnknownError("fs.import", "unknown");
    const server = make(async () => Response.json({ raw: b64(raw) }), {
      materializeGmailFile: async () => {
        throw uncertain;
      },
    });
    await expect(
      server.callToolResult(
        "download_message",
        { messageId: "test" },
        { opengeniOperationId: operationId },
      ),
    ).rejects.toBe(uncertain);
  });

  test("full draft listings allow large inline attachment metadata", async () => {
    const data = b64(Buffer.alloc(7 * 1024 * 1024));
    const server = make(async (input) =>
      new URL(input.toString()).pathname.endsWith("/drafts")
        ? Response.json({ drafts: [{ id: "large-draft" }] })
        : Response.json({
            id: "large-draft",
            message: {
              id: "large-message",
              payload: {
                filename: "test.bin",
                mimeType: "application/octet-stream",
                body: { data, size: 7 * 1024 * 1024 },
              },
            },
          }),
    );
    expect((await value(server, "list_drafts")).drafts[0].attachments[0].size).toBe(
      7 * 1024 * 1024,
    );
  });

  test("gateway preserves both refused and uncertain Gmail write outcomes", async () => {
    const refused = await make(async () => Response.json({})).callToolResult("delete_label", {
      labelId: "INBOX",
    });
    expect(gmailRestResultOutcome(refused)).toBe("not_executed");
    const server = make(async () => {
      throw new Error("lost response");
    });
    const gateway = new PrefixedMcpServer(server, "gmail-test", undefined, true);
    const result = await gateway.executeCatalogTool("create_label", { name: "Test" });
    expect(gmailRestResultOutcome(result)).toBe("uncertain");
    await expect(
      runRecoverableMcpOperation(
        {
          operationId,
          serverId: "gmail-test",
          originalTool: "create_label",
          observerTool: "get_label",
          destinationDigest: "synthetic",
          argumentDigest: "synthetic",
        },
        {
          capture: async () => "created",
          settleOriginal: async () => {
            throw new Error("must not settle complete");
          },
        },
        async () => await gateway.executeCatalogTool("create_label", { name: "Test" }),
      ),
    ).rejects.toMatchObject({ code: 40_102, connectorActionOutcome: "uncertain" });
  });

  test("attempt gateway settles Gmail semantic refusal and transport uncertainty truthfully", async () => {
    for (const uncertain of [false, true]) {
      const outcomes: string[] = [];
      const prepared = await prepareAgentTools(
        testSettings({
          mcpServers: [
            {
              id: "gmail",
              url: "https://gmailmcp.googleapis.com/mcp/v1",
              allowedTools: ["create_label", "delete_label"],
              connectionRef: {
                providerDomain: "gmailmcp.googleapis.com",
                kind: "oauth2",
                subjectScope: "subject",
              },
            },
          ],
        }),
        [{ kind: "mcp", id: "gmail" }],
        {
          accountId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          sessionId: "33333333-3333-4333-8333-333333333333",
          turnId: "44444444-4444-4444-8444-444444444444",
          attemptId: "55555555-5555-4555-8555-555555555555",
          executionGeneration: 1,
          credentialSubjectId: "test-owner",
          resolveCredential: async () => ({
            status: "ok",
            headers: {},
            connectionId: "test-connection",
          }),
          mcpFetchImpl: async () => {
            throw new Error("synthetic lost response");
          },
          connectorActionPolicy: {
            prepare: async () => ({ managed: true, decision: "allow" }),
            begin: async () => ({ allowed: true, managed: true, requestId: operationId }),
            complete: async (input) => {
              outcomes.push(input.outcome);
            },
          },
        },
      );
      try {
        await expect(
          prepared.attemptToolEnvironment!.call({
            operationId,
            catalogDigest: prepared.attemptToolCatalog!.digest,
            identity: { serverId: "gmail", toolName: uncertain ? "create_label" : "delete_label" },
            arguments: uncertain ? { name: "Test" } : { labelId: "INBOX" },
            caller: { kind: "codemode", subjectId: "test-owner" },
          }),
        ).rejects.toMatchObject({
          connectorActionOutcome: uncertain ? "uncertain" : "not_executed",
        });
        expect(outcomes).toEqual([uncertain ? "uncertain" : "not_executed"]);
      } finally {
        await prepared.close();
      }
    }
  });
});
