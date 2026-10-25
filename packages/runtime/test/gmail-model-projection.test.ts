import { describe, expect, test } from "bun:test";
import {
  modelToolOutputSerializationBudgetTokens,
  truncateMiddleWithTokenBudget,
} from "@opengeni/codex";
import type { AttemptToolExecutionContext } from "@opengeni/codemode";
import type { AttemptToolResult } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import { PrefixedMcpServer, prefixedMcpToolName, prepareAgentTools } from "../src";
import { GmailRestMcpServer, type GmailRestMcpServerOptions } from "../src/gmail-rest-mcp";
import {
  GMAIL_MODEL_BODY_MAX_CHARS,
  GMAIL_MODEL_BODY_MIN_CHARS,
  htmlToText,
  projectGmailToolResultForModel,
} from "../src/gmail-model-projection";
import { mcpResultModelContent, unwrapSdkMcpResultProjection } from "../src/mcp-result-custom-data";
import { MCP_MAX_TOOL_RESULT_BYTES } from "../src/mcp-network";
import {
  modelToolResultFits,
  modelToolTextBudgetBytes,
  wrapAttemptToolExecute,
} from "../src/tool-result-spill";
import { syntheticGmailFetch, syntheticInboxPage } from "./fixtures/gmail-mailbox";

type Card = Record<string, unknown> & { plaintextBody?: string | null };

const connectionRef = {
  providerDomain: "gmailmcp.googleapis.com",
  kind: "oauth2" as const,
  subjectScope: "subject" as const,
};

function gmail(fetchImpl: typeof fetch): GmailRestMcpServer {
  const options: GmailRestMcpServerOptions = {
    workspaceId: "workspace-test",
    serverId: "gmail",
    connectionRef,
    resolveCredential: async () => ({
      status: "ok",
      headers: { authorization: "Bearer synthetic-token" },
      connectionId: "connection-test",
    }),
    fetchImpl,
  };
  return new GmailRestMcpServer(options);
}

async function exact(
  server: GmailRestMcpServer,
  tool: string,
  args: Record<string, unknown>,
): Promise<AttemptToolResult> {
  const result = (await server.callToolResult(tool, args)) as AttemptToolResult;
  expect(result.isError).not.toBe(true);
  return result;
}

function structured(result: AttemptToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const modelText = (result: AttemptToolResult) =>
  mcpResultModelContent(result)
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
const modelTextBytes = (result: AttemptToolResult) => Buffer.byteLength(modelText(result));
/** The default model's tool-output policy: the generic truncation keeps this text whole. */
const defaultPolicyTokens = modelToolOutputSerializationBudgetTokens();
const keptWhole = (result: AttemptToolResult) =>
  truncateMiddleWithTokenBudget(modelText(result), defaultPolicyTokens) === modelText(result);

function context(kind: "model" | "codemode"): AttemptToolExecutionContext {
  return {
    operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    caller: { kind, subjectId: kind === "codemode" ? "codemode:test" : "worker:mcp-model" },
  };
}

const page = syntheticInboxPage(50);

describe("Gmail model-visible projection", () => {
  test("a 50-message FULL_CONTENT search becomes compact triage cards", async () => {
    const server = gmail(syntheticGmailFetch(page));
    const result = await exact(server, "search_messages", {
      pageSize: 50,
      messageFormat: "FULL_CONTENT",
    });
    const projected = projectGmailToolResultForModel("search_messages", result);
    const value = structured(projected);
    expect(JSON.parse((projected.content[0] as { text: string }).text)).toEqual(value);
    expect(value.nextPageToken).toBe("next-page");
    expect(value.resultCountEstimate).toBe(201);
    expect(value.readWith).toBe("get_message");
    const cards = value.messages as Card[];
    expect(cards).toHaveLength(50);
    for (const card of cards) {
      for (const dropped of [
        "headers",
        "mimeParts",
        "htmlBody",
        "attachmentIds",
        "sizeEstimate",
        "historyId",
        "internalDate",
      ]) {
        expect(card).not.toHaveProperty(dropped);
      }
      expect(card.plaintextBody!.length).toBeGreaterThanOrEqual(
        Math.min(GMAIL_MODEL_BODY_MIN_CHARS, 100),
      );
      expect(card.plaintextBody!.length).toBeLessThan(1_000);
    }
    const newsletter = cards[0]!;
    expect(newsletter).toMatchObject({
      id: page[0]!.id,
      threadId: page[0]!.threadId,
      sender: "Product Weekly <news@example.test>",
      dateTime: "2026-10-24T18:00:00.000Z",
      labelIds: ["CATEGORY_UPDATES", "INBOX", "UNREAD"],
      contentTruncated: true,
    });
    expect(newsletter.toRecipients).toEqual(['"Owner" <owner@example.test>']);
    expect(newsletter.ccRecipients).toEqual(['"Team" <team@example.test>']);
    // Bulk mail asks for replies elsewhere; personal mail has no Reply-To.
    expect(newsletter.replyTo).toBe("Support <support@example.test>");
    const personal = cards.find((card) => card.sender === "Alex Example <alex@example.test>")!;
    expect(personal).not.toHaveProperty("replyTo");
    expect(typeof newsletter.subject).toBe("string");
    // The snippet is the start of the plain-text body already shown.
    expect(newsletter).not.toHaveProperty("snippet");
    const exactNewsletter = (structured(result).messages as Card[])[0]!;
    expect(exactNewsletter.plaintextBody!.startsWith(newsletter.plaintextBody!.slice(0, 200))).toBe(
      true,
    );

    const withAttachment = cards[9]!;
    expect(withAttachment.attachments).toEqual(["invoice-1009.pdf"]);
    expect(withAttachment.contentTruncated).toBe(true);
    expect(withAttachment).not.toHaveProperty("ccRecipients");

    const htmlOnly = cards[8]!;
    expect(htmlOnly.bodyFromHtml).toBe(true);
    expect(typeof htmlOnly.snippet).toBe("string");
    expect(htmlOnly.plaintextBody).not.toMatch(/<|&nbsp;|\.c\{|\u034f|\u200c/u);
    expect(htmlOnly.plaintextBody!.startsWith("Your weekly picks are here\n")).toBe(true);
  });

  test("a realistic 50-message FULL_CONTENT page fits the model without a spill", async () => {
    const server = gmail(syntheticGmailFetch(page));
    const result = await exact(server, "search_messages", {
      pageSize: 50,
      messageFormat: "FULL_CONTENT",
    });
    // The exact result is what previously reached the spill (about 3.5 MB here).
    expect(bytes(result)).toBeGreaterThan(3 * MCP_MAX_TOOL_RESULT_BYTES);
    expect(modelToolResultFits(result)).toBe(false);
    const projected = projectGmailToolResultForModel("search_messages", result);
    expect(modelToolResultFits(projected)).toBe(true);
    // What the model reads (one copy of the structured value) fits the default
    // 10,000-token tool-output policy, so no message is cut out of the middle.
    expect(modelTextBytes(projected)).toBeLessThanOrEqual(modelToolTextBudgetBytes());
    expect(modelTextBytes(projected)).toBeGreaterThan(modelToolTextBudgetBytes() * 0.9);
    expect(keptWhole(projected)).toBe(true);
    expect(keptWhole(result)).toBe(false);
  });

  test("bodies grow with the model's tool-output budget and always fit it", async () => {
    const server = gmail(syntheticGmailFetch(page));
    const result = await exact(server, "search_messages", {
      pageSize: 50,
      messageFormat: "FULL_CONTENT",
    });
    const bodyChars = (maxTextBytes: number) => {
      const projected = projectGmailToolResultForModel("search_messages", result, {
        maxTextBytes,
      });
      expect(modelTextBytes(projected)).toBeLessThanOrEqual(maxTextBytes);
      return (structured(projected).messages as Card[]).reduce(
        (total, card) => total + (card.plaintextBody?.length ?? 0),
        0,
      );
    };
    const small = bodyChars(modelToolTextBudgetBytes(10_000));
    const large = bodyChars(modelToolTextBudgetBytes(40_000));
    expect(large).toBeGreaterThan(3 * small);
    // A huge budget keeps every body up to the per-message maximum.
    const projected = projectGmailToolResultForModel("search_messages", result, {
      maxTextBytes: 10_000_000,
    });
    const cards = structured(projected).messages as Card[];
    const exactCards = structured(result).messages as Card[];
    expect(cards[9]!.plaintextBody).toBe(exactCards[9]!.plaintextBody!.trim());
    expect(cards[0]!.plaintextBody!.length).toBeLessThanOrEqual(GMAIL_MODEL_BODY_MAX_CHARS);
    expect(cards[0]!.plaintextBody!.length).toBeGreaterThan(GMAIL_MODEL_BODY_MAX_CHARS - 100);
  });

  test("the worst case of 50 maximal bodies stays bounded", () => {
    const huge = "word ".repeat(60_000);
    const messages = Array.from({ length: 50 }, (_, index) => ({
      id: `m${index}`,
      threadId: `t${index}`,
      sender: "Sender <sender@example.test>",
      toRecipients: ["owner@example.test"],
      dateTime: "2026-10-24T18:00:00.000Z",
      subject: "s".repeat(998),
      snippet: "x".repeat(200),
      labelIds: ["INBOX"],
      headers: [{ name: "X-Padding", value: "p".repeat(20_000) }],
      plaintextBody: huge,
      htmlBody: `<p>${huge}</p>`,
      contentTruncated: true,
      mimeParts: [],
    }));
    const value = { messages, resultCountEstimate: 50 };
    const projected = projectGmailToolResultForModel("search_messages", {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
    });
    expect(modelToolResultFits(projected)).toBe(true);
    expect(modelTextBytes(projected)).toBeLessThan(150_000);
  });

  test("a thread keeps its identity and gives each message a larger body share", async () => {
    const server = gmail(syntheticGmailFetch(page));
    const result = await exact(server, "get_thread", { threadId: "thread-1" });
    const value = structured(projectGmailToolResultForModel("get_thread", result));
    expect(value).toMatchObject({ id: "thread-1", historyId: "9100000", readWith: "get_message" });
    const cards = value.messages as Card[];
    expect(cards).toHaveLength(6);
    expect(cards[0]!.plaintextBody!.length).toBeGreaterThan(1_600);
    expect(cards[0]!.plaintextBody!.length).toBeLessThanOrEqual(GMAIL_MODEL_BODY_MAX_CHARS);
    expect(cards[0]!.contentTruncated).toBe(true);
    expect(cards[0]).not.toHaveProperty("headers");
    expect(cards[0]).not.toHaveProperty("htmlBody");
    expect(bytes(result)).toBeGreaterThan(10 * bytes(value));
  });

  test("thread search and draft lists drop repeated metadata the same way", () => {
    const message = {
      id: "m1",
      threadId: "t1",
      sender: "a@example.test",
      toRecipients: [],
      ccRecipients: [],
      bccRecipients: [],
      date: "2026-10-24",
      dateTime: "2026-10-24T18:00:00.000Z",
      labelIds: ["INBOX"],
      internalDate: "1792864800000",
      sizeEstimate: 100,
      historyId: "9",
      headers: [{ name: "From", value: "a@example.test" }],
      subject: "Hello",
      snippet: "Hi there",
    };
    const threads = { threads: [{ id: "t1", messages: [message] }], resultCountEstimate: "1" };
    const projectedThreads = structured(
      projectGmailToolResultForModel("search_threads", {
        content: [{ type: "text", text: JSON.stringify(threads) }],
        structuredContent: threads,
      }),
    );
    expect(projectedThreads).toEqual({
      threads: [
        {
          id: "t1",
          messages: [
            {
              id: "m1",
              threadId: "t1",
              sender: "a@example.test",
              dateTime: "2026-10-24T18:00:00.000Z",
              subject: "Hello",
              labelIds: ["INBOX"],
              snippet: "Hi there",
            },
          ],
        },
      ],
      resultCountEstimate: "1",
    });

    const drafts = {
      drafts: [
        {
          ...message,
          id: "r1",
          draftId: "r1",
          messageId: "m1",
          plaintextBody: "Draft text",
          htmlBody: "<p>Draft text</p>",
          contentTruncated: false,
          mimeParts: [],
        },
      ],
    };
    const [draft] = structured(
      projectGmailToolResultForModel("list_drafts", {
        content: [{ type: "text", text: JSON.stringify(drafts) }],
        structuredContent: drafts,
      }),
    ).drafts as Card[];
    expect(draft).toEqual({
      draftId: "r1",
      messageId: "m1",
      threadId: "t1",
      sender: "a@example.test",
      dateTime: "2026-10-24T18:00:00.000Z",
      subject: "Hello",
      labelIds: ["INBOX"],
      plaintextBody: "Draft text",
      contentTruncated: false,
    });
  });

  test("get_message stays complete except a redundant HTML body", async () => {
    const server = gmail(syntheticGmailFetch(page));
    const result = await exact(server, "get_message", { messageId: page[0]!.id });
    const exactValue = structured(result);
    const projected = projectGmailToolResultForModel("get_message", result);
    const { htmlBody, ...kept } = exactValue;
    expect(typeof htmlBody).toBe("string");
    expect(structured(projected)).toEqual({ ...kept, htmlBodyOmitted: true });
    expect(structured(projected).headers).toEqual(exactValue.headers);
    expect(structured(projected).mimeParts).toEqual(exactValue.mimeParts);
    expect(structured(projected).plaintextBody).toBe(exactValue.plaintextBody);

    const htmlOnly = await exact(server, "get_message", { messageId: page[8]!.id });
    expect(structured(htmlOnly).plaintextBody).toBeNull();
    // The fixture's HTML-only message is mostly markup and over the default
    // budget, so the model reads its text instead of a middle-cut HTML string.
    expect(modelTextBytes(htmlOnly)).toBeGreaterThan(modelToolTextBudgetBytes());
    const htmlProjected = projectGmailToolResultForModel("get_message", htmlOnly);
    const { htmlBody: _html, ...htmlKept } = structured(htmlOnly);
    expect(structured(htmlProjected)).toEqual({
      ...htmlKept,
      plaintextBody: htmlToText(structured(htmlOnly).htmlBody as string),
      bodyFromHtml: true,
      htmlBodyOmitted: true,
    });
    expect(structured(htmlProjected).plaintextBody).toMatch(/^Your weekly picks are here\n/u);
    expect(keptWhole(htmlProjected)).toBe(true);
    // An HTML-only message that fits keeps its markup (and so its links).
    expect(
      projectGmailToolResultForModel("get_message", htmlOnly, { maxTextBytes: 10_000_000 }),
    ).toBe(htmlOnly);
  });

  test("Reply-To is kept only when it names another address than the sender", () => {
    const message = (id: string, sender: string, replyTo?: string) => ({
      id,
      sender,
      headers: [
        { name: "From", value: sender },
        ...(replyTo === undefined ? [] : [{ name: "reply-to", value: replyTo }]),
      ],
    });
    const value = {
      messages: [
        message("none", "Ann <ann@example.test>"),
        message("same", "Ann <ann@example.test>", "ANN@example.test"),
        message("other", "Ann <ann@example.test>", "Desk <desk@example.test>"),
        message("partly", "Ann <ann@example.test>", "ann@example.test, bob@example.test"),
        message("blank", "Ann <ann@example.test>", "  "),
      ],
    };
    const cards = structured(
      projectGmailToolResultForModel("search_messages", {
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
      }),
    ).messages as Card[];
    expect(cards.map((card) => [card.id, card.replyTo ?? null])).toEqual([
      ["none", null],
      ["same", null],
      ["other", "Desk <desk@example.test>"],
      ["partly", "ann@example.test, bob@example.test"],
      ["blank", null],
    ]);
  });

  test("contentTruncated reports both the bridge cap and the model cap", () => {
    const value = {
      messages: [
        { id: "short", plaintextBody: "Short body.", htmlBody: null, contentTruncated: false },
        { id: "bridge-cut", plaintextBody: "Short body.", htmlBody: null, contentTruncated: true },
        { id: "empty", plaintextBody: null, htmlBody: null, contentTruncated: false },
      ],
    };
    const cards = structured(
      projectGmailToolResultForModel("search_messages", {
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
      }),
    ).messages as Card[];
    expect(cards.map((card) => [card.id, card.plaintextBody, card.contentTruncated])).toEqual([
      ["short", "Short body.", false],
      ["bridge-cut", "Short body.", true],
      ["empty", null, false],
    ]);

    // Under a tight budget the long body is cut and also takes the share the
    // short body leaves unused.
    const long = "Long line of mail text. ".repeat(500);
    const mixed = {
      messages: [
        { id: "short", plaintextBody: "Short body.", htmlBody: null, contentTruncated: false },
        { id: "long", plaintextBody: long, htmlBody: null, contentTruncated: false },
      ],
    };
    const tight = projectGmailToolResultForModel(
      "search_messages",
      { content: [{ type: "text", text: JSON.stringify(mixed) }], structuredContent: mixed },
      { maxTextBytes: 2_000 },
    );
    const [short, cut] = structured(tight).messages as Card[];
    expect(short).toMatchObject({ plaintextBody: "Short body.", contentTruncated: false });
    expect(cut!.contentTruncated).toBe(true);
    expect(cut!.plaintextBody!.length).toBeGreaterThan(1_500);
    expect(long.startsWith(cut!.plaintextBody!)).toBe(true);
    expect(bytes(structured(tight))).toBeLessThanOrEqual(2_000);
  });

  test("leaves errors, unknown shapes and other tools unchanged", () => {
    const error: AttemptToolResult = {
      isError: true,
      content: [{ type: "text", text: "Gmail failed" }],
      structuredContent: { error: { code: "tool_failed" } },
    };
    expect(projectGmailToolResultForModel("search_messages", error)).toBe(error);
    const odd: AttemptToolResult = {
      content: [{ type: "text", text: "{}" }],
      structuredContent: { messages: "not a list" },
    };
    expect(projectGmailToolResultForModel("search_messages", odd)).toBe(odd);
    const labels: AttemptToolResult = {
      content: [{ type: "text", text: '{"labels":[]}' }],
      structuredContent: { labels: [] },
    };
    expect(projectGmailToolResultForModel("list_labels", labels)).toBe(labels);
    const ids = { messages: [{ id: "a", threadId: "b" }] };
    const idsResult: AttemptToolResult = {
      content: [{ type: "text", text: JSON.stringify(ids) }],
      structuredContent: ids,
    };
    expect(structured(projectGmailToolResultForModel("search_messages", idsResult))).toEqual(ids);
  });

  test("HTML text extraction is readable and linear on hostile input", () => {
    expect(
      htmlToText(
        "<html><head><style>p{color:red}</style><title>T</title></head><body><!-- hidden --><p>Hello&nbsp;<b>world</b> &amp; &#8364;5 &#x1F600;</p><ul><li>One</li><li>Two</li></ul><script>alert(1)</script>Bye<br>now</body></html>",
      ),
    ).toBe("Hello world & \u20ac5 \u{1F600}\n\n- One\n- Two\nBye\nnow");
    expect(htmlToText("<p>a < b and c > d</p><style>unterminated")).toBe("a < b and c > d");
    const hostile = "<style".repeat(40_000) + "<a".repeat(40_000) + "&#99999999;".repeat(5_000);
    const startedAt = performance.now();
    htmlToText(hostile);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });
});

describe("Gmail projection at the per-caller seam", () => {
  test("the model receives the projection while Codemode receives the exact result", async () => {
    const server = gmail(syntheticGmailFetch(page));
    const result = await exact(server, "search_messages", {
      pageSize: 50,
      messageFormat: "FULL_CONTENT",
    });
    const spills: unknown[] = [];
    const execute = wrapAttemptToolExecute(
      async () => result,
      async (input) => {
        spills.push(input);
        throw new Error("must not spill");
      },
      { serverId: "gmail", toolName: "search_messages" },
      (value) =>
        server.projectModelToolResult("search_messages", value, {
          maxTextBytes: modelToolTextBudgetBytes(),
        }),
    );
    expect(await execute({}, context("codemode"))).toBe(result);
    const model = await execute({}, context("model"));
    expect(model).toEqual(projectGmailToolResultForModel("search_messages", result));
    expect(spills).toEqual([]);
  });

  test("a throwing projection leaves the exact result for the model", async () => {
    const result: AttemptToolResult = { content: [{ type: "text", text: "ok" }] };
    const execute = wrapAttemptToolExecute(
      async () => result,
      undefined,
      undefined,
      () => {
        throw new Error("projection bug");
      },
    );
    expect(await execute({}, context("model"))).toBe(result);
  });

  test("the prefixed server exposes only a bridge's own projection", () => {
    const bridged = new PrefixedMcpServer(gmail(syntheticGmailFetch(page)), "gmail");
    expect(bridged.hasModelToolResultProjection()).toBe(true);
    const nested = new PrefixedMcpServer(bridged, "outer");
    expect(nested.hasModelToolResultProjection()).toBe(true);
    const plain = new PrefixedMcpServer(
      {
        name: "plain",
        cacheToolsList: false,
        async connect() {},
        async close() {},
        async listTools() {
          return [];
        },
        async callTool() {
          return [];
        },
        async invalidateToolsCache() {},
      },
      "plain",
    );
    expect(plain.hasModelToolResultProjection()).toBe(false);
    const result: AttemptToolResult = { content: [{ type: "text", text: "ok" }] };
    expect(plain.projectModelToolResult("search_messages", result, { maxTextBytes: 1_000 })).toBe(
      result,
    );
  });

  test("a prepared attempt projects model calls and keeps Codemode exact", async () => {
    const spills: number[] = [];
    let policyTokens = 20_000;
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "gmail",
            url: "https://gmailmcp.googleapis.com/mcp/v1",
            allowedTools: ["search_messages", "list_labels"],
            connectionRef,
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
        mcpFetchImpl: syntheticGmailFetch(page),
        connectorActionPolicy: {
          prepare: async () => ({ managed: true, decision: "allow" }),
          begin: async () => ({
            allowed: true,
            managed: true,
            requestId: "66666666-6666-4666-8666-666666666666",
          }),
          complete: async () => {},
        },
        spillOversizedModelToolResult: async ({ serializedBytes }) => {
          spills.push(serializedBytes);
          throw new Error("must not spill");
        },
        // Read per call: the projection is sized to the current model's policy.
        modelToolOutputTruncationTokens: () => policyTokens,
      },
    );
    try {
      const args = { pageSize: 50, messageFormat: "FULL_CONTENT" };
      const server = prepared.mcpServers.find(
        (candidate) => candidate instanceof PrefixedMcpServer && candidate.registryId === "gmail",
      )!;
      const model = unwrapSdkMcpResultProjection(
        await server.callToolResult!(prefixedMcpToolName("gmail", "search_messages"), args),
      ) as AttemptToolResult;
      const modelValue = (model.structuredContent ??
        JSON.parse((model.content[0] as { text: string }).text)) as { messages: Card[] };
      expect(modelValue.messages).toHaveLength(50);
      expect(modelValue.messages[0]).not.toHaveProperty("headers");
      expect(modelValue.messages[0]).not.toHaveProperty("htmlBody");
      expect(spills).toEqual([]);

      const codemode = await prepared.attemptToolEnvironment!.call({
        operationId: crypto.randomUUID(),
        catalogDigest: prepared.attemptToolCatalog!.digest,
        identity: { serverId: "gmail", toolName: "search_messages" },
        arguments: args,
        caller: { kind: "codemode", subjectId: "codemode:test" },
      });
      const exactValue = codemode.structuredContent as { messages: Card[] };
      expect(exactValue.messages).toHaveLength(50);
      expect(exactValue.messages[0]).toHaveProperty("headers");
      expect(typeof exactValue.messages[0]!.htmlBody).toBe("string");
      expect(bytes(codemode)).toBeGreaterThan(MCP_MAX_TOOL_RESULT_BYTES);
      expect(model.structuredContent).toEqual(
        projectGmailToolResultForModel("search_messages", codemode, {
          maxTextBytes: modelToolTextBudgetBytes(20_000),
        }).structuredContent,
      );
      policyTokens = 10_000;
      const smaller = unwrapSdkMcpResultProjection(
        await server.callToolResult!(prefixedMcpToolName("gmail", "search_messages"), args),
      ) as AttemptToolResult;
      expect(modelTextBytes(smaller)).toBeLessThanOrEqual(modelToolTextBudgetBytes(10_000));
      expect(bytes(smaller)).toBeLessThan(bytes(model));
    } finally {
      await prepared.close();
    }
  });
});
