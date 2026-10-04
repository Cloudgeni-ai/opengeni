import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { GmailRestMcpServer, GMAIL_REST_MCP_TOOLS } from "../src/gmail-rest-mcp";

// Protocol expectations come from Google's discovery document, not adapter URLs.
// The fixture retains only public method IDs, verbs and paths.
test("all Gmail bridge tools conform to the published eligible REST routes", async () => {
  const contract = await Bun.file(
    new URL("./fixtures/gmail-rest-routes.json", import.meta.url),
  ).json();
  const methods: Array<{ id: string; httpMethod: string; path: string }> = contract.methods;
  const routes = methods.map((method) => ({
    ...method,
    pattern: new RegExp(
      "^/" +
        method.path
          .split(/(\{[^}]+\})/)
          .map((part) => (part.startsWith("{") ? (part === "{userId}" ? "me" : "[^/]+") : part))
          .join("") +
        "$",
    ),
  }));
  const coveredMethods = new Set<string>(),
    coveredTools = new Set<string>();
  const bytes = Buffer.from("To: owner@example.test\r\nSubject: Synthetic\r\n\r\nSynthetic body");
  const raw = bytes.toString("base64url");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const message = {
    id: "message-test",
    threadId: "thread-test",
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "To", value: "owner@example.test" }],
      body: { data: Buffer.from("Synthetic body").toString("base64url"), size: 14 },
    },
  };
  const server = new GmailRestMcpServer({
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
      authorizeProviderRequest: async () => true,
    }),
    watchTopicName: "projects/example-project/topics/synthetic-mail",
    materializeGmailFile: async (request) => {
      expect(await request.authorizeProviderRequest()).toBe(true);
      return {
        sandboxPath: "synthetic/file",
        contentSha256: createHash("sha256").update(request.bytes).digest("hex"),
      };
    },
    fetchImpl: async (input, init) => {
      const url = new URL(input.toString()),
        verb = init?.method ?? "GET";
      expect(url.origin).toBe("https://gmail.googleapis.com");
      const matched = routes.find(
        (route) => route.httpMethod === verb && route.pattern.test(url.pathname),
      );
      expect(matched, verb + " " + url.pathname).toBeDefined();
      if (!matched) throw new Error("Request does not match the public discovery contract");
      coveredMethods.add(matched.id);
      if (
        verb === "DELETE" ||
        url.pathname.endsWith("/batchModify") ||
        url.pathname.endsWith("/stop")
      )
        return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/profile"))
        return Response.json({ emailAddress: "owner@example.test", historyId: "123" });
      if (url.pathname.endsWith("/history") || url.pathname.endsWith("/watch"))
        return Response.json({ history: [], historyId: "123", expiration: "999" });
      if (url.pathname.endsWith("/drafts"))
        return Response.json(verb === "GET" ? { drafts: [] } : { id: "draft-test", message });
      if (url.pathname.endsWith("/drafts/draft-test"))
        return Response.json({ id: "draft-test", message: { ...message, raw } });
      if (url.pathname.endsWith("/messages") && verb === "GET")
        return Response.json({ messages: [] });
      if (url.pathname.endsWith("/messages/message-test"))
        return Response.json({ ...message, raw });
      if (url.pathname.includes("/attachments/"))
        return Response.json({ data: Buffer.from("fixture").toString("base64url"), size: 7 });
      if (url.pathname.endsWith("/threads")) return Response.json({ threads: [] });
      if (url.pathname.endsWith("/threads/thread-test"))
        return Response.json({ id: "thread-test", messages: [message] });
      if (url.pathname.endsWith("/labels") && verb === "GET") return Response.json({ labels: [] });
      return Response.json({
        id: "Label_test",
        threadId: "thread-test",
        name: "Synthetic",
        labelIds: [],
      });
    },
  });
  const cases: Array<[string, Record<string, unknown>]> = [
    ["get_profile", {}],
    ["search_messages", { query: "subject:Synthetic" }],
    ["search_threads", { query: "subject:Synthetic" }],
    ["get_message", { messageId: "message-test" }],
    ["get_thread", { threadId: "thread-test" }],
    ["list_drafts", {}],
    ["create_draft", { raw }],
    ["get_draft", { draftId: "draft-test" }],
    ["update_draft", { draftId: "draft-test", raw }],
    ["delete_draft", { draftId: "draft-test" }],
    ["send_draft", { draftId: "draft-test", expectedContentSha256: hash }],
    ["send_message", { raw }],
    ["list_labels", {}],
    ["get_label", { labelId: "Label_test" }],
    ["create_label", { name: "Synthetic" }],
    ["update_label", { labelId: "Label_test", name: "Patched" }],
    ["update_label", { labelId: "Label_test", name: "Replaced", replace: true }],
    ["delete_label", { labelId: "Label_test" }],
    ["label_message", { messageId: "message-test", labelIds: ["Label_test"] }],
    ["unlabel_message", { messageId: "message-test", labelIds: ["Label_test"] }],
    ["label_thread", { threadId: "thread-test", labelIds: ["Label_test"] }],
    ["unlabel_thread", { threadId: "thread-test", labelIds: ["Label_test"] }],
    ["modify_message", { messageId: "message-test", addLabelIds: ["STARRED"] }],
    ["modify_thread", { threadId: "thread-test", removeLabelIds: ["UNREAD"] }],
    ["batch_modify_messages", { messageIds: ["message-test"], addLabelIds: ["IMPORTANT"] }],
    ["trash_message", { messageId: "message-test" }],
    ["restore_message", { messageId: "message-test" }],
    ["trash_thread", { threadId: "thread-test" }],
    ["restore_thread", { threadId: "thread-test" }],
    ["download_attachment", { messageId: "message-test", attachmentId: "opaque-token" }],
    ["download_message", { messageId: "message-test" }],
    ["get_history", { startHistoryId: "123" }],
    ["watch_mailbox", {}],
    ["stop_watch", {}],
    ["import_message", { raw }],
    ["insert_message", { raw }],
  ];
  for (const resource of ["autoForwarding", "imap", "language", "pop", "vacation"])
    cases.push(["get_settings", { resource }]);
  for (const resource of [
    "sendAs",
    "filters",
    "forwardingAddresses",
    "smimeInfo",
    "cseIdentities",
    "cseKeypairs",
  ]) {
    cases.push(["list_settings", { resource, sendAsEmail: "owner@example.test" }]);
    cases.push([
      "get_settings",
      { resource, id: "synthetic-id", sendAsEmail: "owner@example.test" },
    ]);
  }
  for (const [tool, args] of cases) {
    const result = await server.callToolResult(tool, args, {
      opengeniOperationId: "12345678-1234-4123-8123-123456789abc",
    });
    expect(result.isError, tool + ": " + JSON.stringify(result.content)).not.toBe(true);
    coveredTools.add(tool);
  }
  expect([...coveredTools].sort()).toEqual(GMAIL_REST_MCP_TOOLS.map((tool) => tool.name).sort());
  expect([...coveredMethods].sort()).toEqual(methods.map((method) => method.id).sort());
});
