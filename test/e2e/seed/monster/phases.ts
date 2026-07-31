/**
 * Phase composers for the monster chat seed.
 * Each phase fills a share of the EventBudget; builder orchestrates order + exact pad.
 */

import {
  applyPatch,
  execFail,
  execOk,
  execRunning,
  fatText,
  mcpError,
  mcpIssue,
  sessionCreate,
  sessionCreateRunning,
  sessionSendMessage,
  toolTourSpecs,
  viewImage,
  writeStdin,
} from "./payloads.ts";
import { uuidFromRng, type EventBudget } from "./budget.ts";

export type PhaseShares = {
  warmup: number;
  solo1: number;
  tour: number;
  pingpong: number;
  solo2: number;
  workers: number;
  reliability: number;
  noise: number;
  coda: number;
};

/** Monster/50k approximate allocation from the plan. */
export const DEFAULT_SHARES: PhaseShares = {
  warmup: 0.01,
  solo1: 0.32,
  tour: 0.1,
  pingpong: 0.15,
  solo2: 0.22,
  workers: 0.04,
  reliability: 0.04,
  noise: 0.05,
  /** Newest open-page chat density (matches browser INITIAL_TAIL_PAGE_SIZE). */
  coda: 0.1,
};

/**
 * Newest events the web client opens with (`INITIAL_TAIL_PAGE_SIZE` in
 * `@opengeni/react`). The tip must be chat-dense so open lands on visible
 * conversation rather than non-rendering `fs.changed` / usage noise.
 */
export const TIP_PAGE_EVENTS = 1000;

/** Event types that project into the timeline (vs dock/fs/usage noise). */
export const TIMELINE_DENSE_TYPES = new Set([
  "user.message",
  "turn.queued",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "agent.message.delta",
  "agent.message.completed",
  "agent.reasoning.delta",
  "agent.toolCall.created",
  "agent.toolCall.output",
  "goal.set",
  "goal.updated",
  "goal.completed",
  "goal.paused",
  "goal.resumed",
  "goal.continuation",
  "goal.cleared",
  "memory.saved",
  "memory.corrected",
  "session.context.compaction.requested",
  "session.context.compacted",
  "session.context.compaction.skipped",
  "sandbox.operation.started",
  "sandbox.operation.completed",
  "sandbox.operation.failed",
  "sandbox.command.output.delta",
]);

export function tipReserve(
  target: number,
  remaining: number,
  shares: PhaseShares = DEFAULT_SHARES,
): number {
  const fromShare = phaseCap(target, shares.coda);
  const desired = Math.max(fromShare, Math.min(TIP_PAGE_EVENTS, Math.floor(target * 0.15)));
  return Math.min(remaining, desired);
}

export function phaseCap(target: number, share: number): number {
  return Math.max(8, Math.floor(target * share));
}

export function phaseWarmup(budget: EventBudget): void {
  const turnId = budget.nextTurnId();
  if (!budget.beginTurn("Kick off the monster chat seed — short warm-up.", turnId)) return;
  budget.push("agent.reasoning.delta", { text: "Quick ack, then the long runs begin." }, turnId);
  budget.push(
    "agent.message.completed",
    { text: "Warm-up complete. Starting the agent marathon." },
    turnId,
  );
  budget.endTurn(turnId);
}

export function phaseSoloMarathon(
  budget: EventBudget,
  opts: { userText: string; cap: number; mode: "dense" | "sparse" | "fat"; closing: string },
): void {
  const turnId = budget.nextTurnId();
  const before = budget.count;
  if (!budget.beginTurn(opts.userText, turnId)) return;
  budget.fillActivity(turnId, Math.max(0, opts.cap - (budget.count - before) - 2), opts.mode);
  budget.push("agent.message.completed", { text: opts.closing }, turnId);
  budget.endTurn(turnId);
}

export function phaseToolTour(
  budget: EventBudget,
  opts: { fat: boolean; target: number; shares: PhaseShares },
): void {
  const turnId = budget.nextTurnId();
  if (
    budget.beginTurn(
      "Exercise every special tool renderer path (exec, patch, computer, search, image, secrets, MCP).",
      turnId,
    )
  ) {
    budget.push(
      "agent.reasoning.delta",
      { text: "Touring each tool × state so the timeline UI can stress every renderer." },
      turnId,
    );
    const specs = toolTourSpecs((label) => budget.nextCallId(label));
    for (const spec of specs) {
      if (budget.remaining() < 4) break;
      budget.tool(spec, turnId);
    }
    budget.push(
      "tool.auth_needed",
      {
        serverId: "mcp-linear",
        toolName: "create_issue",
        providerDomain: "linear.app",
        connectionId: "conn-linear-1",
        reason: "refresh_failed",
        scopes: ["issues:write"],
        resource: "https://mcp.linear.app/sse",
      },
      turnId,
    );
    budget.push(
      "agent.message.completed",
      { text: "Tool tour complete (including historical auth_needed cards)." },
      turnId,
    );
    budget.endTurn(turnId);
  }

  const tourEnd =
    phaseCap(opts.target, opts.shares.warmup) +
    phaseCap(opts.target, opts.shares.solo1) +
    phaseCap(opts.target, opts.shares.tour);
  while (budget.count < tourEnd && !budget.full()) {
    const encoreId = budget.nextTurnId();
    if (!budget.beginTurn(`Tool tour encore ${budget.count}`, encoreId)) break;
    budget.fillActivity(encoreId, Math.min(40, budget.remaining() - 2), opts.fat ? "fat" : "dense");
    budget.endTurn(encoreId);
  }
}

export function phasePingPong(budget: EventBudget, cap: number): void {
  const pingTarget = budget.count + cap;
  let i = 0;
  while (budget.count < pingTarget && budget.remaining() > 8) {
    i += 1;
    const turnId = budget.nextTurnId();
    const steer = i % 5 === 0;
    if (
      !budget.beginTurn(
        steer
          ? `Steer: drop the CSS work and focus on the failing test in suite ${i}.`
          : `Short human note ${i}: please check status and continue.`,
        turnId,
      )
    ) {
      break;
    }
    budget.tool(execOk(budget.nextCallId("pp"), `echo ping-${i}`), turnId);
    if (i % 3 === 0) {
      budget.tool(applyPatch(budget.nextCallId("pp-ap"), `src/ping-${i}.ts`, i), turnId);
    }
    budget.push(
      "agent.message.completed",
      { text: `Acknowledged ping ${i}${steer ? " (steered)" : ""}.` },
      turnId,
    );
    budget.endTurn(turnId);
  }
}

export function phaseWorkersGoalsMemory(budget: EventBudget, children: string[]): void {
  const turnId = budget.nextTurnId();
  if (
    budget.beginTurn(
      "Spin up workers, set a goal, and update workspace memory conventions.",
      turnId,
    )
  ) {
    budget.push("goal.set", { text: "monster seed suite green & dashboard captured" }, turnId);
    if (children[0]) {
      budget.tool(
        sessionCreate(budget.nextCallId("wk"), children[0], "verify login flow end-to-end"),
        turnId,
      );
      budget.tool(
        sessionSendMessage(budget.nextCallId("wk-msg"), children[0], "please finish assertions"),
        turnId,
      );
    }
    if (children[1]) {
      budget.tool(
        sessionCreateRunning(budget.nextCallId("wk-run"), "migrate billing service"),
        turnId,
      );
      budget.tool(
        sessionCreate(budget.nextCallId("wk2"), children[1], "migrate billing service"),
        turnId,
      );
    }
    if (children[2]) {
      budget.tool(
        sessionCreate(budget.nextCallId("wk3"), children[2], "capture p95 latency baseline"),
        turnId,
      );
    }
    budget.push("goal.updated", { text: "also wire CI on green" }, turnId);
    budget.push("goal.paused", { text: "blocked on missing GHCR pull credentials" }, turnId);
    budget.push("goal.resumed", { text: "credentials restored — continuing" }, turnId);
    budget.push("goal.continuation", { text: "still wiring CI on green" }, turnId);
    budget.push(
      "memory.saved",
      {
        memoryId: uuidFromRng(budget.rng),
        kind: "preference",
        preview: "Prefer Terraform over Pulumi for all new infrastructure in this workspace.",
        deduped: false,
      },
      turnId,
    );
    budget.push(
      "memory.saved",
      {
        memoryId: uuidFromRng(budget.rng),
        kind: "semantic",
        preview: "Staging deploys run from the main branch only.",
        deduped: false,
      },
      turnId,
    );
    budget.push(
      "memory.corrected",
      {
        memoryId: uuidFromRng(budget.rng),
        kind: "semantic",
        preview: "The staging database is walrus-primary.",
        action: "superseded",
        reason: "Verified in-session.",
        replacementMemoryId: uuidFromRng(budget.rng),
        replacementPreview: "The staging database is walrus-2 (Postgres 16).",
      },
      turnId,
    );
    budget.push(
      "memory.corrected",
      {
        memoryId: uuidFromRng(budget.rng),
        kind: "procedural",
        preview: "Run database migrations with `make db-migrate` before every deploy.",
        action: "updated",
        reason: "The command moved under the ops wrapper.",
      },
      turnId,
    );
    budget.push("goal.completed", { text: "suite green, dashboard captured" }, turnId);
    budget.push(
      "agent.message.completed",
      { text: "Workers spawned, goal lifecycle exercised, memories saved/corrected." },
      turnId,
    );
    budget.endTurn(turnId);
  }

  if (children[0] && budget.remaining() > 0) {
    budget.push("user.message", {
      text: "Login flow verified end-to-end. All assertions passed.",
      childCompletion: {
        childSessionId: children[0],
        status: "idle",
        goal: {
          status: "completed",
          text: "verify login flow end-to-end",
          evidence: "assertions green; screenshot captured.",
        },
      },
    });
  }
  if (children[1] && budget.remaining() > 0) {
    budget.push("user.message", {
      text: "I paused the migration worker — needs GHCR credentials.",
      childCompletion: {
        childSessionId: children[1],
        status: "idle",
        goal: {
          status: "paused",
          text: "migrate the billing service",
          pausedReason: "missing GHCR pull credentials",
        },
      },
    });
  }
  if (children[2] && budget.remaining() > 0) {
    budget.push("user.message", {
      text: "The load-test worker failed: staging returned 503.",
      childCompletion: {
        childSessionId: children[2],
        status: "failed",
        goal: {
          status: "active",
          text: "capture a p95 latency baseline against staging",
        },
      },
    });
  }
}

export function phaseReliability(budget: EventBudget, fat: boolean): void {
  const failId = budget.nextTurnId();
  if (budget.beginTurn("Deploy the preview to staging.", failId)) {
    budget.tool(execFail(budget.nextCallId("fail"), "helm upgrade preview ./chart"), failId);
    budget.endTurn(failId, "failed", "helm upgrade failed — ImagePullBackOff");
  }

  const cancelId = budget.nextTurnId();
  if (budget.beginTurn("Tail the prod logs forever.", cancelId)) {
    budget.tool(execRunning(budget.nextCallId("cancel"), "kubectl logs -f deploy/api"), cancelId);
    budget.endTurn(cancelId, "cancelled");
  }

  const relId = budget.nextTurnId();
  if (!budget.beginTurn("Recover after sandbox blip and compact context.", relId)) return;
  budget.push(
    "sandbox.operation.failed",
    { operation: "exec", error: "sandbox unavailable", code: "SANDBOX_UNAVAILABLE" },
    relId,
  );
  budget.push("session.context.compaction.requested", { reason: "budget" }, relId);
  budget.push("session.context.compacted", { summaryTokens: 1200, retainedMessages: 8 }, relId);
  budget.push("session.context.compaction.skipped", { reason: "already_compact" }, relId);
  budget.push("codex.capacity.waiting", { reason: "all_exhausted", resetAt: null }, relId);
  budget.push("codex.capacity.resumed", { reason: "capacity_available" }, relId);
  budget.push("turn.capacity_waiting", { reason: "allocator" }, relId);
  budget.tool(writeStdin(budget.nextCallId("rel-ws")), relId);
  budget.tool(viewImage(budget.nextCallId("rel-vi")), relId);
  budget.tool(mcpError(budget.nextCallId("rel-mcp")), relId);
  budget.tool(mcpIssue(budget.nextCallId("rel-issue"), "Flaky after recover"), relId);
  if (fat) {
    budget.push(
      "agent.message.completed",
      { text: fatText(Math.floor(budget.rng() * 1e6), 50_000) },
      relId,
    );
  } else {
    budget.push(
      "agent.message.completed",
      { text: "Recovered, compacted, capacity wait exercised." },
      relId,
    );
  }
  budget.endTurn(relId);
}

export function phaseCoda(budget: EventBudget): void {
  const turnId = budget.nextTurnId();
  if (!budget.beginTurn("Final wrap-up: summarize what landed and stop idle.", turnId)) return;
  budget.push(
    "agent.reasoning.delta",
    { text: "Coda — short clean exchange so the transcript ends readable." },
    turnId,
  );
  budget.tool(execOk(budget.nextCallId("coda"), "echo done"), turnId);
  budget.push(
    "agent.message.completed",
    {
      text: "Monster seed coda complete. Session settles idle — open the timeline and scroll.",
    },
    turnId,
  );
  budget.endTurn(turnId);
}

/**
 * Fill the newest window with realistic chat (messages, tools, turn lifecycle).
 * Called after mid-history noise so open lands on visible conversation.
 */
export function phaseTipChat(budget: EventBudget, fat: boolean): void {
  let tipTurn = 0;
  while (!budget.full() && budget.remaining() >= 6) {
    tipTurn += 1;
    const turnId = budget.nextTurnId();
    const prompts = [
      "Show the latest CI status and the failing test name.",
      "Patch the flake and re-run the targeted suite.",
      "Open the preview URL and confirm the dashboard cards.",
      "Summarize what shipped since the last checkpoint.",
      "Wire the remaining TODO and leave the session idle.",
    ];
    const prompt = prompts[(tipTurn - 1) % prompts.length]!;
    if (!budget.beginTurn(`${prompt} (tip ${tipTurn})`, turnId)) break;

    const before = budget.count;
    // Leave room for closing message + turn.completed.
    const activityCap = Math.min(fat ? 24 : 18, Math.max(0, budget.remaining() - 2));
    budget.fillActivity(turnId, activityCap, fat ? "fat" : "dense");
    if (budget.count === before && budget.remaining() > 2) {
      budget.push(
        "agent.reasoning.delta",
        { text: `Tip turn ${tipTurn}: checking outputs, then answering.` },
        turnId,
      );
      budget.tool(execOk(budget.nextCallId("tip"), `echo tip-${tipTurn}`), turnId);
    }
    if (budget.remaining() > 1) {
      budget.push(
        "agent.message.completed",
        {
          text: `Tip exchange ${tipTurn}: checks look good; continuing the readable tail.`,
        },
        turnId,
      );
    }
    budget.endTurn(turnId);
  }
  // Exact budget: one last readable coda if anything remains.
  if (!budget.full()) {
    phaseCoda(budget);
  }
}

export function runAllPhases(
  budget: EventBudget,
  opts: { children: string[]; fat: boolean; target: number; shares?: PhaseShares },
): void {
  const shares = opts.shares ?? DEFAULT_SHARES;
  phaseWarmup(budget);
  phaseSoloMarathon(budget, {
    userText:
      "Run a long unsupervised refactor: auth, tests, browser verify, and CI wiring. Keep going until the suite is green.",
    cap: phaseCap(opts.target, shares.solo1),
    mode: opts.fat ? "fat" : "dense",
    closing: "Solo marathon 1 checkpoint reached; handing back for the tool tour.",
  });
  phaseToolTour(budget, { fat: opts.fat, target: opts.target, shares });
  phasePingPong(budget, phaseCap(opts.target, shares.pingpong));
  phaseSoloMarathon(budget, {
    userText: "Insane agent stretch again — dense tools, sparse narration, keep shipping.",
    cap: phaseCap(opts.target, shares.solo2),
    mode: opts.fat ? "fat" : "sparse",
    closing: "Second marathon complete.",
  });
  phaseWorkersGoalsMemory(budget, opts.children);
  phaseReliability(budget, opts.fat);

  // Noise belongs in older/mid history — never at the open tip.
  const tip = tipReserve(opts.target, budget.remaining(), shares);
  if (budget.remaining() > tip) {
    const noiseCap = Math.min(budget.remaining() - tip, phaseCap(opts.target, shares.noise));
    budget.padNoise(noiseCap);
    // Any leftover above the tip (phases under-filled) stays for tip chat, not
    // more invisible pad — tip density beats exact noise share.
  }
  phaseTipChat(budget, opts.fat);
}
