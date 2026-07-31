/**
 * PRNG, sequence budget, and turn helpers for the monster chat seed.
 */

import type { AppendEventInput } from "@opengeni/db";
import type { SessionEventType } from "@opengeni/contracts";
import {
  applyPatch,
  computerScreenshot,
  execFat,
  execHuge,
  execOk,
  mcpOk,
  webSearch,
  type ToolSpec,
} from "./payloads.ts";

/** Mulberry32 — tiny deterministic PRNG. */
export function createRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function uuidFromRng(rng: () => number): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(rng() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function histogramOf(events: AppendEventInput[]): Record<string, number> {
  const hist: Record<string, number> = {};
  for (const event of events) {
    hist[event.type] = (hist[event.type] ?? 0) + 1;
  }
  return hist;
}

/** Stable hash of a type→count histogram (order-independent). */
export function hashHistogram(histogram: Record<string, number>): string {
  const keys = Object.keys(histogram).sort();
  const body = keys.map((k) => `${k}:${histogram[k]}`).join("|");
  let h = 2166136261;
  for (let i = 0; i < body.length; i += 1) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export class EventBudget {
  readonly events: AppendEventInput[] = [];
  private tick = 0;
  private callSeq = 0;
  private triggerSeq = 0;
  private readonly startMs: number;

  constructor(
    readonly target: number,
    readonly rng: () => number,
  ) {
    this.startMs = Date.UTC(2026, 0, 15, 12, 0, 0) + Math.floor(this.rng() * 1_000);
  }

  get count(): number {
    return this.events.length;
  }

  remaining(): number {
    return Math.max(0, this.target - this.events.length);
  }

  full(): boolean {
    return this.events.length >= this.target;
  }

  nextTurnId(): string {
    return uuidFromRng(this.rng);
  }

  nextCallId(label: string): string {
    this.callSeq += 1;
    return `call-${label}-${this.callSeq}`;
  }

  nextTriggerKey(): string {
    this.triggerSeq += 1;
    return `monster:trigger:${this.triggerSeq}`;
  }

  push(type: SessionEventType, payload: unknown = {}, turnId: string | null = null): boolean {
    if (this.full()) return false;
    this.tick += 1 + Math.floor(this.rng() * 40);
    this.events.push({
      type,
      payload,
      turnId,
      occurredAt: new Date(this.startMs + this.tick),
    });
    return true;
  }

  tool(spec: ToolSpec, turnId: string): number {
    let n = 0;
    if (
      this.push(
        "agent.toolCall.created",
        {
          id: spec.id,
          name: spec.name,
          arguments: spec.arguments ?? null,
          raw: spec.raw,
        },
        turnId,
      )
    ) {
      n += 1;
    }
    if (!spec.running && (spec.output !== undefined || spec.error)) {
      if (
        this.push(
          "agent.toolCall.output",
          { id: spec.id, output: spec.output ?? null, error: spec.error ?? false },
          turnId,
        )
      ) {
        n += 1;
      }
    }
    return n;
  }

  /**
   * Open a conversational turn: user.message → turn.queued → turn.started.
   * triggerEventId uses clientEventId marker; seed CLI rewrites after insert.
   */
  beginTurn(userText: string, turnId: string, extraPayload: Record<string, unknown> = {}): boolean {
    if (this.remaining() < 4) return false;
    const triggerKey = this.nextTriggerKey();
    this.tick += 1;
    this.events.push({
      type: "user.message",
      payload: { text: userText, ...extraPayload },
      clientEventId: triggerKey,
      turnId: null,
      occurredAt: new Date(this.startMs + this.tick),
    });
    this.push("turn.queued", { turnId, triggerEventId: triggerKey, source: "user" }, turnId);
    this.push("turn.started", { triggerEventId: triggerKey, turnId }, turnId);
    return true;
  }

  endTurn(
    turnId: string,
    terminal: "completed" | "failed" | "cancelled" = "completed",
    error?: string,
  ): boolean {
    if (terminal === "failed") {
      return this.push("turn.failed", { error: error ?? "seed failure" }, turnId);
    }
    if (terminal === "cancelled") {
      return this.push("turn.cancelled", {}, turnId);
    }
    return this.push("turn.completed", {}, turnId);
  }

  fillActivity(turnId: string, cap: number, mode: "dense" | "sparse" | "fat" = "dense"): number {
    let added = 0;
    while (added < cap && !this.full()) {
      const roll = this.rng();
      if (mode === "fat" || (mode === "dense" && roll < 0.08)) {
        added += this.tool(execFat(this.nextCallId("fat"), Math.floor(this.rng() * 1e9)), turnId);
        continue;
      }
      if (roll < 0.25) {
        if (
          this.push(
            "agent.reasoning.delta",
            {
              text: `Considering step ${this.callSeq}: inspect outputs, patch the failing path, re-run checks.`,
            },
            turnId,
          )
        ) {
          added += 1;
        }
      } else if (roll < 0.4) {
        if (
          this.push(
            "agent.message.delta",
            { text: `Working through item ${this.callSeq}…` },
            turnId,
          )
        ) {
          added += 1;
        }
      } else if (roll < 0.55) {
        added += this.tool(
          execOk(this.nextCallId("ex"), `echo step-${this.callSeq} && ls -la`),
          turnId,
        );
      } else if (roll < 0.65) {
        added += this.tool(
          applyPatch(this.nextCallId("ap"), `src/mod-${this.callSeq % 40}.ts`, this.callSeq),
          turnId,
        );
      } else if (roll < 0.72) {
        added += this.tool(webSearch(this.nextCallId("ws"), `query ${this.callSeq}`), turnId);
      } else if (roll < 0.78) {
        added += this.tool(computerScreenshot(this.nextCallId("cc")), turnId);
      } else if (roll < 0.84) {
        added += this.tool(execHuge(this.nextCallId("huge")), turnId);
      } else if (roll < 0.9) {
        if (
          this.push(
            "sandbox.command.output.delta",
            { text: `stdout line ${this.callSeq}\n`, stream: "stdout" },
            turnId,
          )
        ) {
          added += 1;
        }
      } else if (roll < 0.95) {
        added += this.tool(mcpOk(this.nextCallId("mcp")), turnId);
      } else if (
        this.push(
          "agent.message.completed",
          { text: `Checkpoint ${this.callSeq}: continuing the marathon.` },
          turnId,
        )
      ) {
        added += 1;
      }
      if (mode === "sparse" && this.rng() < 0.3) {
        if (
          this.push(
            "agent.reasoning.delta",
            { text: "Sparse narration between tool clusters." },
            turnId,
          )
        ) {
          added += 1;
        }
      }
    }
    return added;
  }

  padNoise(count: number): number {
    let added = 0;
    while (added < count && !this.full()) {
      const roll = this.rng();
      if (roll < 0.35) {
        if (
          this.push("fs.changed", {
            path: `/workspace/src/f-${this.callSeq}.ts`,
            revision: this.callSeq,
            op: "modified",
          })
        ) {
          added += 1;
        }
      } else if (roll < 0.55) {
        if (this.push("git.changed", { revision: this.callSeq, dirty: true })) {
          added += 1;
        }
      } else if (roll < 0.7) {
        if (
          this.push("agent.model.usage", {
            inputTokens: 1000 + Math.floor(this.rng() * 5000),
            outputTokens: 200 + Math.floor(this.rng() * 2000),
            model: "scripted-model",
          })
        ) {
          added += 1;
        }
      } else if (roll < 0.85) {
        const ptyId = uuidFromRng(this.rng);
        if (this.push("terminal.pty.started", { ptyId })) added += 1;
        if (!this.full() && this.push("terminal.pty.output.delta", { ptyId, data: "echo hi\n" })) {
          added += 1;
        }
        if (!this.full() && this.push("terminal.pty.exited", { ptyId, exitCode: 0 })) {
          added += 1;
        }
      } else if (
        this.push("artifact.created", {
          artifactId: uuidFromRng(this.rng),
          kind: "file",
          path: `/workspace/artifacts/a-${this.callSeq}.bin`,
        })
      ) {
        added += 1;
      }
      this.callSeq += 1;
    }
    return added;
  }
}
