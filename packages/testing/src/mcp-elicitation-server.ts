import {
  CLIENT_CAPABILITIES_META_KEY,
  createMcpHandler,
  inputRequired,
  inputResponse,
  McpServer,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

/**
 * A scriptable MCP server (protocol revision 2026-07-28) whose tools ask the
 * person questions mid-call with the multi round-trip pattern, for testing
 * clients end to end. It asks only where it should, honours what the client
 * declared, and records every `tools/call` with its retry fields.
 *
 * - `send_message` goes straight through to trusted chats and asks for
 *   confirmation (a form with no fields) before sending anywhere else; a
 *   decline answers "Not sent."
 * - `book_meeting` asks for details in a form, then for confirmation in a
 *   second round, carrying its progress in `requestState`.
 * - `warm_up` first answers with state only, then asks.
 * - `sign_in` asks the person to open a sign-in page (URL mode) and asks
 *   again until the test calls `finishSignIn` for that account, as a real
 *   server would after its page's out-of-band step. The server SDK refuses to
 *   ask unless the client declared URL mode.
 */

export type FakeMcpElicitationCall = {
  name: string;
  arguments: Record<string, unknown>;
  /** Whether the call declared form elicitation in its per-request capabilities. */
  declaredElicitation: boolean;
  /** Whether the call declared URL elicitation in its per-request capabilities. */
  declaredUrlElicitation: boolean;
  inputResponses?: Record<string, unknown>;
  requestState?: string;
};

export type FakeMcpElicitationServerOptions = {
  /** Chats `send_message` sends to without asking. */
  trustedChats?: readonly string[];
};

const SendArguments = { chat: z.string(), text: z.string() };
const BookArguments = { topic: z.string() };
const SignInArguments = { account: z.string() };
const Sent = z.object({ sent: z.boolean(), chat: z.string() });

export class FakeMcpElicitationServer {
  readonly calls: FakeMcpElicitationCall[] = [];
  /** Messages actually sent, in order. */
  readonly sent: Array<{ chat: string; text: string }> = [];
  readonly booked: Array<Record<string, unknown>> = [];
  /** Accounts whose sign-in page the person finished. */
  private readonly signedIn = new Set<string>();
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly trusted: ReadonlySet<string>;

  constructor(options: FakeMcpElicitationServerOptions = {}) {
    this.trusted = new Set(options.trustedChats ?? []);
  }

  get url(): string {
    if (!this.server) throw new Error("fake MCP elicitation server is not started");
    return `http://127.0.0.1:${this.server.port}/mcp`;
  }

  start(): this {
    const handler = createMcpHandler(() => this.createMcp());
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (request.method === "POST") {
          const body = (await request
            .clone()
            .json()
            .catch(() => null)) as { method?: unknown; params?: Record<string, unknown> } | null;
          if (body?.method === "tools/call" && body.params) this.record(body.params);
        }
        return await handler.fetch(request);
      },
    });
    return this;
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
    this.server = null;
  }

  /** Calls to one tool, in order. */
  callsTo(name: string): FakeMcpElicitationCall[] {
    return this.calls.filter((call) => call.name === name);
  }

  /** The person finished the sign-in page for this account (the out-of-band step). */
  finishSignIn(account: string): void {
    this.signedIn.add(account);
  }

  /** The page `sign_in` sends the person to for an account. */
  static signInUrl(account: string): string {
    return `https://accounts.example.com/sign-in?account=${encodeURIComponent(account)}`;
  }

  private record(params: Record<string, unknown>): void {
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const capabilities = (meta[CLIENT_CAPABILITIES_META_KEY] ?? {}) as {
      elicitation?: { form?: unknown; url?: unknown };
    };
    this.calls.push({
      name: String(params.name),
      arguments: (params.arguments ?? {}) as Record<string, unknown>,
      declaredElicitation: capabilities.elicitation?.form !== undefined,
      declaredUrlElicitation: capabilities.elicitation?.url !== undefined,
      ...(params.inputResponses
        ? { inputResponses: params.inputResponses as Record<string, unknown> }
        : {}),
      ...(typeof params.requestState === "string" ? { requestState: params.requestState } : {}),
    });
  }

  /** The client said it can answer forms on this very call. */
  private canAsk(): boolean {
    return this.calls.at(-1)?.declaredElicitation === true;
  }

  private createMcp(): McpServer {
    const mcp = new McpServer({ name: "fake-mcp-elicitation", version: "1.0.0" });
    mcp.registerTool(
      "send_message",
      {
        description: "Send a message to a chat.",
        inputSchema: z.object(SendArguments),
        outputSchema: Sent,
      },
      async ({ chat, text }, ctx) => {
        const send = () => {
          this.sent.push({ chat, text });
          return {
            content: [{ type: "text" as const, text: `Sent to ${chat}.` }],
            structuredContent: { sent: true, chat },
          };
        };
        if (this.trusted.has(chat)) return send();
        const answer = inputResponse(ctx.mcpReq.inputResponses, "confirm");
        if (answer.kind === "elicit") {
          if (answer.action === "accept") return send();
          return {
            content: [{ type: "text" as const, text: "Not sent." }],
            structuredContent: { sent: false, chat },
          };
        }
        if (!this.canAsk()) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Sending to ${chat} needs a confirmation.` }],
          };
        }
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: `Send “${text}” to ${chat}?`,
              requestedSchema: { type: "object", properties: {} },
            }),
          },
        });
      },
    );
    mcp.registerTool(
      "book_meeting",
      { description: "Book a meeting.", inputSchema: z.object(BookArguments) },
      async ({ topic }, ctx) => {
        const state = ctx.mcpReq.requestState<string>();
        const details = inputResponse(ctx.mcpReq.inputResponses, "details");
        if (state === undefined) {
          return inputRequired({
            inputRequests: {
              details: inputRequired.elicit({
                message: `Who should come to “${topic}”, and when?`,
                requestedSchema: {
                  type: "object",
                  properties: {
                    room: {
                      type: "string",
                      title: "Room",
                      oneOf: [
                        { const: "small", title: "Small room" },
                        { const: "large", title: "Large room" },
                      ],
                      default: "small",
                    },
                    attendees: { type: "integer", title: "People", minimum: 1, maximum: 20 },
                    note: { type: "string", title: "Note", maxLength: 200 },
                  },
                  required: ["room", "attendees"],
                },
              }),
            },
            requestState: JSON.stringify({ step: "details", topic }),
          });
        }
        const progress = JSON.parse(state) as { step: string; topic: string; details?: unknown };
        if (progress.step === "details") {
          if (details.kind !== "elicit" || details.action !== "accept") {
            return { content: [{ type: "text" as const, text: "Not booked." }] };
          }
          return inputRequired({
            inputRequests: {
              confirm: inputRequired.elicit({
                message: `Book ${String(details.content?.room)} room for ${String(details.content?.attendees)}?`,
                requestedSchema: { type: "object", properties: {} },
              }),
            },
            requestState: JSON.stringify({ step: "confirm", topic, details: details.content }),
          });
        }
        const confirm = inputResponse(ctx.mcpReq.inputResponses, "confirm");
        if (confirm.kind !== "elicit" || confirm.action !== "accept") {
          return { content: [{ type: "text" as const, text: "Not booked." }] };
        }
        this.booked.push({ topic, ...(progress.details as Record<string, unknown>) });
        return { content: [{ type: "text" as const, text: `Booked “${topic}”.` }] };
      },
    );
    mcp.registerTool("warm_up", { description: "Warm up, then ask." }, async (ctx) => {
      const state = ctx.mcpReq.requestState<string>();
      if (state === undefined) return inputRequired({ requestState: "warm" });
      const answer = inputResponse(ctx.mcpReq.inputResponses, "go");
      if (answer.kind === "elicit" && answer.action === "accept") {
        return { content: [{ type: "text" as const, text: "Warmed up." }] };
      }
      return inputRequired({
        inputRequests: {
          go: inputRequired.elicit({
            message: "Go?",
            requestedSchema: { type: "object", properties: {} },
          }),
        },
        requestState: "asked",
      });
    });
    mcp.registerTool(
      "sign_in",
      {
        description: "Connect an account through its sign-in page.",
        inputSchema: z.object(SignInArguments),
      },
      async ({ account }, ctx) => {
        const answer = inputResponse(ctx.mcpReq.inputResponses, "signIn");
        if (answer.kind === "elicit" && answer.action !== "accept") {
          return { content: [{ type: "text" as const, text: "Not signed in." }] };
        }
        if (answer.kind === "elicit" && this.signedIn.has(account)) {
          return { content: [{ type: "text" as const, text: `Signed in to ${account}.` }] };
        }
        // First call, or the person continued before finishing the page.
        return inputRequired({
          inputRequests: {
            signIn: inputRequired.elicitUrl({
              message: `Sign in to ${account} to continue.`,
              url: FakeMcpElicitationServer.signInUrl(account),
            }),
          },
          requestState: JSON.stringify({ account }),
        });
      },
    );
    return mcp;
  }
}

export function startFakeMcpElicitationServer(
  options: FakeMcpElicitationServerOptions = {},
): FakeMcpElicitationServer {
  return new FakeMcpElicitationServer(options).start();
}
