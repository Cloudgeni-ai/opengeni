/**
 * Builds real-shaped session event logs for the design-preview seed.
 *
 * Every payload mirrors what the worker and API persist (see
 * packages/runtime/src/run-events.ts, apps/worker/src/activities/agent-turn and
 * packages/react/demo/timeline-fixtures.ts), so the web timeline projects the
 * seeded history exactly like a real session. Nothing here talks to a model:
 * the builder only produces rows for `session_events`.
 */
import { randomUUID } from "node:crypto";

export type SeedEventRow = {
  id: string;
  turnId: string | null;
  generation: number | null;
  association: "current" | null;
  type: string;
  payload: Record<string, unknown>;
  /** Milliseconds after the conversation start. */
  offsetMs: number;
};

export type Initiator = { kind: "subject" | "service"; label: string; subjectId: string };

/** How the last turn of a script ends; drives the session row status too. */
export type SessionOutcome = "idle" | "failed" | "requires_action" | "running" | "cancelled";

export type ApplyPatchOperation = {
  type: "create_file" | "update_file" | "delete_file";
  path: string;
  diff: string;
};

export type HumanInputQuestion = {
  id: string;
  kind: "text" | "single_select" | "multi_select";
  prompt: string;
  label?: string;
  helpText?: string;
  options?: { id: string; label: string; description?: string }[];
  required?: boolean;
  allowOther?: boolean;
};

/** A pending structured question; the seed also writes its request row. */
export type PendingHumanInput = {
  requestId: string;
  toolCallId: string;
  turnId: string;
  questions: HumanInputQuestion[];
  allowSkip: boolean;
};

let callCounter = 0;
const callId = (prefix = "call") =>
  `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}${(callCounter++).toString(36)}`;
const messageId = () => `msg_${randomUUID().replace(/-/g, "")}`;

/** `exec_command` output banner exactly as the sandbox tool returns it. */
export function execOutput(output: string, options: { code?: number; seconds?: number } = {}) {
  const chunk = randomUUID().replace(/-/g, "").slice(0, 6);
  const seconds = (options.seconds ?? 0.4).toFixed(4);
  const body = output.endsWith("\n") || output === "" ? output : `${output}\n`;
  return `Chunk ID: ${chunk}\nWall time: ${seconds} seconds\nProcess exited with code ${options.code ?? 0}\nOutput:\n${body}`;
}

/** MCP text content, the shape first-party and integration tools return. */
export function mcpText(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

export function mcpJson(value: unknown) {
  return mcpText(JSON.stringify(value, null, 2));
}

export class ConversationBuilder {
  readonly rows: SeedEventRow[] = [];
  private at = 0;
  private turn: string | null = null;
  private turnStartedAt = 0;
  outcome: SessionOutcome = "idle";
  pendingHumanInput: PendingHumanInput | null = null;
  /** Turn ids that ended waiting on a person, so the seed can mirror the turn row. */
  requiresActionTurnId: string | null = null;

  constructor(private readonly initiator: Initiator) {}

  /** Advance the clock. */
  wait(seconds: number): this {
    this.at += Math.round(seconds * 1000);
    return this;
  }

  get durationMs() {
    return this.at;
  }

  private push(
    type: string,
    payload: Record<string, unknown>,
    options: { turn?: "none" | "queued" | "current"; after?: number } = {},
  ): SeedEventRow {
    this.wait(options.after ?? 1.5);
    const scope = options.turn ?? (this.turn ? "current" : "none");
    const row: SeedEventRow = {
      id: randomUUID(),
      turnId: scope === "none" ? null : this.turn,
      generation: scope === "current" ? 1 : null,
      association: scope === "current" ? "current" : null,
      type,
      payload,
      offsetMs: this.at,
    };
    this.rows.push(row);
    return row;
  }

  /** A human message that starts a new turn (queued, then started). */
  user(
    text: string,
    options: {
      after?: number;
      resources?: Record<string, unknown>[];
      startup?: [phase: string, ms: number][];
    } = {},
  ): this {
    this.turn = null;
    const message = this.push(
      "user.message",
      {
        text,
        routing: "accepted_for_execution",
        initiator: this.initiator,
        ...(options.resources?.length ? { resources: options.resources } : {}),
      },
      { turn: "none", after: options.after ?? 60 },
    );
    const turnId = randomUUID();
    this.turn = turnId;
    this.push(
      "turn.queued",
      {
        source: "user",
        turnId,
        routing: "accepted_for_execution",
        initiator: this.initiator,
        triggerEventId: message.id,
      },
      { turn: "queued", after: 0.05 },
    );
    this.push("session.status.changed", { status: "running" }, { after: 0.4 });
    this.push("turn.started", { triggerEventId: message.id }, { after: 0.05 });
    this.turnStartedAt = this.at;
    for (const [phase, ms] of options.startup ?? []) {
      this.push("turn.startup.phase.completed", { phase, durationMs: ms }, { after: ms / 1000 });
    }
    return this;
  }

  /** Reasoning summary text (the "Thinking" block). */
  think(text: string, after = 3): this {
    this.push("agent.reasoning.delta", { text }, { after });
    return this;
  }

  /** A progress note between tool calls. */
  say(text: string, after = 2): this {
    this.push(
      "agent.message.completed",
      { text, phase: "commentary", messageId: messageId() },
      { after },
    );
    return this;
  }

  /** A generic function tool (first-party MCP or integration). */
  tool(options: {
    name: string;
    args: Record<string, unknown>;
    output?: unknown;
    error?: boolean;
    display?: { toolName: string; title?: string; accountLabel?: string };
    seconds?: number;
    running?: boolean;
  }): this {
    const id = callId("call");
    const argsJson = JSON.stringify(options.args);
    this.push(
      "agent.toolCall.created",
      {
        id,
        name: options.name,
        arguments: argsJson,
        raw: {
          type: "function_call",
          id: `fc_${id.slice(5)}`,
          callId: id,
          name: options.name,
          status: "completed",
          arguments: argsJson,
        },
        ...(options.display ? { display: options.display } : {}),
      },
      { after: 1.2 },
    );
    if (!options.running) {
      this.push(
        "agent.toolCall.output",
        {
          id,
          output: options.output ?? mcpText("OK"),
          ...(options.error ? { error: true } : {}),
        },
        { after: options.seconds ?? 1.5 },
      );
    }
    return this;
  }

  /** `exec_command` with its real banner output. */
  exec(
    cmd: string,
    output: string,
    options: { code?: number; seconds?: number; workdir?: string; running?: boolean } = {},
  ): this {
    this.tool({
      name: "exec_command",
      args: { cmd, workdir: options.workdir ?? "/workspace", yield_time_ms: 10000 },
      output: execOutput(output, options),
      seconds: options.seconds ?? 0.6,
      ...(options.running ? { running: true } : {}),
    });
    return this;
  }

  /** Hosted `apply_patch_call` with V4A diffs rendered as a Pierre diff. */
  patch(operations: ApplyPatchOperation[], options: { failed?: string } = {}): this {
    const id = callId("call");
    const raw =
      operations.length === 1
        ? { type: "apply_patch_call", callId: id, status: "completed", operation: operations[0] }
        : { type: "apply_patch_call", callId: id, status: "completed", operations };
    this.push(
      "agent.toolCall.created",
      { id, name: "apply_patch_call", arguments: null, raw },
      { after: 4 },
    );
    this.push(
      "agent.toolCall.output",
      {
        id,
        output: options.failed ?? "Patch applied.",
        ...(options.failed ? { error: true } : {}),
      },
      { after: 0.3 },
    );
    return this;
  }

  /** Hosted web search; `results` renders the source list. */
  search(
    query: string,
    results: { title: string; domain: string; snippet: string; url?: string }[] | null,
  ): this {
    const id = `ws_${randomUUID().replace(/-/g, "")}`;
    const action = { type: "search", query, queries: [query] };
    this.push(
      "agent.toolCall.created",
      {
        id,
        name: "web_search_call",
        arguments: action,
        raw: {
          type: "hosted_tool_call",
          id,
          name: "web_search_call",
          status: "completed",
          providerData: { id, type: "web_search_call", action },
        },
      },
      { after: 2 },
    );
    this.push("agent.toolCall.output", { id, output: results ? { results } : null }, { after: 3 });
    return this;
  }

  /** Delegate to a child session (renders the worker card linking to it). */
  spawn(childSessionId: string, initialMessage: string, title: string): this {
    this.tool({
      name: "opengeni__session_create",
      args: { initialMessage, title },
      output: mcpJson({ sessionId: childSessionId, status: "running", title }),
      seconds: 0.8,
    });
    return this;
  }

  /** `sandbox_file_publish`: the file card with preview, Download and Open in Artifacts. */
  publishFile(
    workspaceId: string,
    file: {
      id: string;
      filename: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
      updatedAt: string;
      dimensions?: { width: number; height: number };
    },
    sandboxPath: string,
  ): this {
    const receipt = {
      type: "sandbox_file",
      sandboxPath,
      filename: file.filename,
      artifact: {
        available: true,
        artifactId: file.id,
        kind: "file",
        contentType: file.contentType,
        originalBytes: file.sizeBytes,
        sha256: file.sha256,
        retainedAt: file.updatedAt,
        ...(file.dimensions ? { dimensions: file.dimensions } : {}),
        retention: { policy: "workspace_file", expiresAt: null },
        retrieval: {
          method: "GET",
          path: `/v1/workspaces/${workspaceId}/artifacts/${file.id}/content`,
          acceptRanges: "bytes",
          maxRangeBytes: 1048576,
        },
      },
    };
    this.tool({
      name: "sandbox_file_publish",
      args: { path: sandboxPath },
      output: mcpText(JSON.stringify(receipt)),
      seconds: 1.1,
    });
    return this;
  }

  /** `artifacts_create`: the "Published <Site>" card with an Open link. */
  publishSite(site: {
    id: string;
    workspaceId: string;
    title: string;
    revision: number;
    description?: string;
  }): this {
    this.tool({
      name: "opengeni__artifacts_create",
      args: { title: site.title, description: site.description ?? "", entrypoint: "index.html" },
      output: mcpText(
        JSON.stringify({
          artifact: {
            id: site.id,
            workspaceId: site.workspaceId,
            title: site.title,
            status: "active",
          },
          version: { revision: site.revision },
          replayed: false,
        }),
      ),
      seconds: 2.4,
    });
    return this;
  }

  /** A child's final result delivered back to the parent as machine input. */
  childResult(childSessionId: string, summary: string, failed = false): this {
    this.push(
      "system.update.delivered",
      {
        members: [
          {
            id: randomUUID(),
            kind: "child_terminal_result",
            classification: failed ? "failure" : "success",
            sourceId: childSessionId,
            summary,
          },
        ],
      },
      { after: 40 },
    );
    return this;
  }

  /** Agent-set goal landmark (the goal row itself is written separately). */
  goal(type: "goal.set" | "goal.completed" | "goal.paused", text: string, extra = {}): this {
    this.push(type, { text, actor: "user", ...extra }, { after: 0.5 });
    return this;
  }

  /** Final answer: completes the turn and returns the session to idle. */
  answer(text: string, after = 4): this {
    this.push(
      "agent.message.completed",
      { text, phase: "final_answer", messageId: messageId() },
      { after },
    );
    this.push("turn.completed", { output: text }, { after: 0.2 });
    this.push("session.status.changed", { status: "idle" }, { after: 0.05 });
    this.outcome = "idle";
    this.turn = null;
    return this;
  }

  /** The turn fails with a surfaced error. */
  fail(error: string): this {
    this.push("turn.failed", { error }, { after: 1 });
    this.push("session.status.changed", { status: "failed" }, { after: 0.05 });
    this.outcome = "failed";
    this.turn = null;
    return this;
  }

  /** Someone pressed Stop mid-turn. */
  cancel(): this {
    this.push("turn.cancelled", { reason: "user_cancelled" }, { after: 1 });
    this.push("session.status.changed", { status: "idle" }, { after: 0.05 });
    this.outcome = "idle";
    this.turn = null;
    return this;
  }

  /** The turn is waiting on a tool approval. */
  approval(options: {
    name: string;
    args: Record<string, unknown>;
    display?: { toolName: string; title?: string; accountLabel?: string };
  }): this {
    const id = callId("call");
    const argsJson = JSON.stringify(options.args);
    const rawItem = {
      type: "function_call",
      id: `fc_${id.slice(5)}`,
      callId: id,
      name: options.name,
      status: "completed",
      arguments: argsJson,
    };
    this.push(
      "agent.toolCall.created",
      {
        id,
        name: options.name,
        arguments: argsJson,
        raw: rawItem,
        ...(options.display ? { display: options.display } : {}),
      },
      { after: 1.5 },
    );
    this.push(
      "session.requiresAction",
      {
        approvals: [
          {
            type: "tool_approval_item",
            rawItem,
            toolName: options.name,
            ...(options.display ? { display: options.display } : {}),
          },
        ],
      },
      { after: 0.3 },
    );
    this.push("session.status.changed", { status: "requires_action" }, { after: 0.05 });
    this.outcome = "requires_action";
    this.requiresActionTurnId = this.turn;
    return this;
  }

  /** The agent asks structured questions; `answer` settles them in history. */
  ask(
    questions: HumanInputQuestion[],
    options: {
      allowSkip?: boolean;
      answer?: { questionId: string; values: string[]; other?: string }[];
      after?: number;
    } = {},
  ): this {
    const toolCallId = callId("call");
    const requestId = randomUUID();
    const args = { questions, allowSkip: options.allowSkip ?? false };
    this.push(
      "agent.toolCall.created",
      {
        id: toolCallId,
        name: "request_human_input",
        arguments: JSON.stringify(args),
        raw: {
          type: "function_call",
          callId: toolCallId,
          name: "request_human_input",
          status: "completed",
          arguments: JSON.stringify(args),
        },
      },
      { after: 1.5 },
    );
    this.push(
      "session.humanInput.requested",
      {
        request: {
          id: requestId,
          questions: questions.map((question) => ({
            options: [],
            required: true,
            allowOther: question.kind !== "text",
            ...question,
          })),
          allowSkip: options.allowSkip ?? false,
          expiresAt: null,
        },
      },
      { after: 0.3 },
    );
    if (options.answer) {
      this.push("session.status.changed", { status: "requires_action" }, { after: 0.05 });
      this.push(
        "user.humanInputResponse",
        {
          requestId,
          response: { outcome: "answered", answers: options.answer },
          initiator: this.initiator,
        },
        { after: options.after ?? 45 },
      );
      this.push("session.status.changed", { status: "running" }, { after: 0.3 });
      this.push(
        "agent.toolCall.output",
        {
          id: toolCallId,
          output: mcpJson({ outcome: "answered", answers: options.answer }),
        },
        { after: 0.2 },
      );
    } else {
      this.push("session.status.changed", { status: "requires_action" }, { after: 0.05 });
      this.outcome = "requires_action";
      this.requiresActionTurnId = this.turn;
      this.pendingHumanInput = {
        requestId,
        toolCallId,
        turnId: this.turn!,
        questions,
        allowSkip: options.allowSkip ?? false,
      };
    }
    return this;
  }

  /** Stream part of a message and leave the turn running. */
  streaming(text: string): this {
    this.push("agent.message.delta", { text, messageId: messageId() }, { after: 2 });
    this.outcome = "running";
    return this;
  }

  /** Leave the current turn open with an in-flight step (for "running" sessions). */
  hold(): this {
    this.outcome = "running";
    return this;
  }

  get currentTurnId() {
    return this.turn;
  }

  get turnElapsedMs() {
    return this.at - this.turnStartedAt;
  }
}
