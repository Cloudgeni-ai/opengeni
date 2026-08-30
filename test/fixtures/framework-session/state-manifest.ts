export const FRAMEWORK_SESSION_MANIFEST_VERSION = 1 as const;

export const FRAMEWORK_SESSION_REQUIRED_STATES = {
  "session-lifecycle": [
    "session-boot",
    "session-loading",
    "session-empty",
    "session-idle",
    "session-not-found",
    "session-deleted",
    "session-permission-denied",
    "session-unavailable",
    "session-fatal-error",
  ],
  streaming: [
    "stream-text-slow",
    "stream-text-burst",
    "stream-reasoning",
    "stream-tool-running",
    "stream-tool-success",
    "stream-tool-failure",
    "stream-commentary-no-final",
    "stream-reconnect",
    "stream-offline",
    "stream-gap-backfill",
    "stream-duplicate",
    "stream-out-of-order",
    "stream-unknown-event",
  ],
  composer: [
    "composer-local-edit",
    "composer-autosave",
    "composer-draft-retry",
    "composer-draft-conflict",
    "composer-send",
    "composer-send-optimistic",
    "composer-send-unknown-outcome",
    "composer-steer",
    "composer-send-replaces-wait",
    "composer-disabled",
    "composer-blocked",
    "composer-host-controlled",
  ],
  "queue-control": [
    "queue-empty",
    "queue-one",
    "queue-many",
    "queue-edit",
    "queue-reorder",
    "queue-remove",
    "queue-conflict",
    "queue-unknown-outcome",
    "control-pausing",
    "control-paused",
    "control-resuming",
    "control-stopping",
  ],
  decisions: [
    "approval-pending",
    "approval-approve",
    "approval-reject",
    "approval-terminal-race",
    "human-input-required",
    "human-input-optional",
    "human-input-other",
    "human-input-validation-error",
    "human-input-terminal-race",
  ],
  "goals-lineage": [
    "goal-active",
    "goal-held",
    "goal-paused-cap",
    "goal-paused-budget",
    "goal-paused-user",
    "goal-paused-agent",
    "goal-backoff",
    "goal-completed",
    "goal-cleared",
    "lineage-loading",
    "lineage-children-attention",
  ],
  attachments: [
    "attachment-uploading",
    "attachment-ready",
    "attachment-preview",
    "attachment-remove",
    "attachment-failure",
    "attachment-stale-epoch",
    "attachment-drop",
    "attachment-object-url-release",
    "attachment-fixed-resource-scope",
    "attachment-personal-resource-scope",
  ],
  history: [
    "history-live",
    "history-partial",
    "history-load-older",
    "history-load-newer",
    "history-jump-start",
    "history-jump-latest",
    "history-overlap",
    "history-empty-page",
    "history-filtered-page",
    "history-dense",
    "history-sparse",
    "history-10k",
    "history-8mib",
    "history-unicode-large",
    "timeline-unmatched-output",
  ],
  "host-policy": [
    "model-default",
    "model-external",
    "reasoning-options",
    "latency-options",
    "tool-available",
    "tool-enabled",
    "tool-connection-required",
    "tool-approval-required",
    "tool-denied",
    "tool-unavailable",
    "capability-malformed",
  ],
  lifecycle: [
    "shared-two-consumers",
    "shared-final-release",
    "target-rotation",
    "actor-rotation",
    "ignored-abort",
    "strictmode-replay",
    "svelte-remount",
    "svelte-hmr",
    "hidden-tab",
    "resume-visible",
    "destroy-pending",
    "late-completion",
  ],
} as const;

export type FrameworkSessionArea = keyof typeof FRAMEWORK_SESSION_REQUIRED_STATES;
export type FrameworkSessionStateId =
  (typeof FRAMEWORK_SESSION_REQUIRED_STATES)[FrameworkSessionArea][number];
export type FrameworkSessionAcceptanceCriterion = `AC-${
  | "01"
  | "02"
  | "03"
  | "04"
  | "05"
  | "06"
  | "07"
  | "08"
  | "09"
  | "10"
  | "11"
  | "12"
  | "13"
  | "14"
  | "15"
  | "16"
  | "17"
  | "18"
  | "19"
  | "20"
  | "21"
  | "22"
  | "23"
  | "24"
  | "25"}`;

export type FrameworkSessionVariant = Readonly<{
  id: string;
  viewport: "phone" | "tablet" | "laptop" | "wide";
  theme: "dark" | "light";
  density: "default" | "compact";
  motion: "normal" | "reduced";
  input: "keyboard" | "coarse-pointer";
  content: "ltr" | "unicode-long";
}>;

/**
 * An eight-row mixed-level covering array. It covers every individual value
 * and the risk-significant pairs asserted by validateFrameworkSessionManifest.
 */
export const FRAMEWORK_SESSION_VARIANTS: readonly FrameworkSessionVariant[] = [
  { id: "phone-dark-compact-coarse", viewport: "phone", theme: "dark", density: "compact", motion: "normal", input: "coarse-pointer", content: "ltr" },
  { id: "phone-light-default-keyboard-unicode", viewport: "phone", theme: "light", density: "default", motion: "reduced", input: "keyboard", content: "unicode-long" },
  { id: "tablet-dark-default-keyboard", viewport: "tablet", theme: "dark", density: "default", motion: "normal", input: "keyboard", content: "ltr" },
  { id: "tablet-light-compact-coarse-unicode", viewport: "tablet", theme: "light", density: "compact", motion: "reduced", input: "coarse-pointer", content: "unicode-long" },
  { id: "laptop-dark-compact-keyboard-unicode", viewport: "laptop", theme: "dark", density: "compact", motion: "reduced", input: "keyboard", content: "unicode-long" },
  { id: "laptop-light-default-coarse", viewport: "laptop", theme: "light", density: "default", motion: "normal", input: "coarse-pointer", content: "ltr" },
  { id: "wide-dark-default-coarse-unicode", viewport: "wide", theme: "dark", density: "default", motion: "reduced", input: "coarse-pointer", content: "unicode-long" },
  { id: "wide-light-compact-keyboard", viewport: "wide", theme: "light", density: "compact", motion: "normal", input: "keyboard", content: "ltr" },
] as const;

export type FrameworkSessionScriptStep = Readonly<{
  at: number;
  kind: "resource" | "event" | "mutation" | "lifecycle";
  name: string;
  generation: number;
}>;

export type FrameworkSessionManifestRow = Readonly<{
  id: FrameworkSessionStateId;
  area: FrameworkSessionArea;
  description: string;
  script: Readonly<{
    resources: Readonly<Record<string, string | number | boolean | null>>;
    events: readonly string[];
    steps: readonly FrameworkSessionScriptStep[];
    permissions: readonly string[];
  }>;
  expected: Readonly<{
    controllerPhase: "boot" | "loading" | "ready" | "pending" | "error" | "empty";
    actions: readonly string[];
    semanticTimelineItems: readonly string[];
    componentStates: readonly string[];
    network: Readonly<{ reads: number; mutations: number; streams: number }>;
    resourcesDuringScenario: Readonly<{
      readers: number;
      streams: number;
      listeners: number;
      timers: number;
      objectUrls: number;
    }>;
    teardown: Readonly<{
      readers: 0;
      streams: 0;
      listeners: 0;
      timers: 0;
      objectUrls: 0;
    }>;
  }>;
  evidence: Readonly<{
    controller: string;
    react: string;
    svelte: string;
    browser: string;
    screenshot: string;
  }>;
  variantIds: readonly string[];
  accessibility: Readonly<{
    focus: string;
    liveRegion: string;
    keyboard: readonly string[];
  }>;
  acceptanceCriteria: readonly FrameworkSessionAcceptanceCriterion[];
}>;

type NormalizedTrace = Readonly<{
  stateId: FrameworkSessionStateId;
  ticks: readonly number[];
  calls: readonly string[];
  events: readonly string[];
  generations: readonly number[];
  finalResources: FrameworkSessionManifestRow["expected"]["teardown"];
}>;

const AREA_ACTIONS: Record<FrameworkSessionArea, readonly string[]> = {
  "session-lifecycle": ["refresh-session", "retry-session"],
  streaming: ["follow-latest", "reconnect-stream", "load-gap"],
  composer: ["edit-draft", "save-draft", "send", "steer"],
  "queue-control": ["edit-queue", "reorder-queue", "remove-queue-item", "pause", "resume"],
  decisions: ["approve", "reject", "answer", "skip"],
  "goals-lineage": ["refresh-goal", "update-goal", "clear-goal", "refresh-lineage"],
  attachments: ["upload", "preview", "remove", "drop"],
  history: ["load-older", "load-newer", "jump-start", "jump-latest"],
  "host-policy": ["select-model", "select-reasoning", "select-latency", "toggle-tool"],
  lifecycle: ["mount", "subscribe", "rotate-target", "release"],
};

const AREA_ACS: Record<FrameworkSessionArea, readonly FrameworkSessionAcceptanceCriterion[]> = {
  "session-lifecycle": ["AC-03", "AC-04", "AC-12", "AC-15", "AC-21"],
  streaming: ["AC-04", "AC-05", "AC-06", "AC-15", "AC-21"],
  composer: ["AC-04", "AC-07", "AC-12", "AC-15", "AC-21"],
  "queue-control": ["AC-04", "AC-09", "AC-12", "AC-15", "AC-21"],
  decisions: ["AC-04", "AC-09", "AC-18", "AC-21"],
  "goals-lineage": ["AC-04", "AC-09", "AC-15", "AC-21"],
  attachments: ["AC-08", "AC-10", "AC-15", "AC-21"],
  history: ["AC-05", "AC-06", "AC-19", "AC-20", "AC-21"],
  "host-policy": ["AC-15", "AC-17", "AC-18", "AC-19", "AC-21"],
  lifecycle: ["AC-10", "AC-14", "AC-16", "AC-20", "AC-21"],
};

const AREA_REACT_EVIDENCE: Record<FrameworkSessionArea, string> = {
  "session-lifecycle": "packages/react/test/use-session.test.tsx",
  streaming: "packages/react/test/use-session-events.test.tsx",
  composer: "packages/react/test/hooks.test.tsx",
  "queue-control": "packages/react/test/queue-surface.test.tsx",
  decisions: "packages/react/test/approval-surface.test.ts",
  "goals-lineage": "packages/react/test/hooks.test.tsx",
  attachments: "packages/react/test/use-file-attachments.test.tsx",
  history: "packages/react/test/message-timeline-pagination.test.tsx",
  "host-policy": "packages/react/test/chat-composer-controls.test.tsx",
  lifecycle: "packages/react/test/use-session-events.test.tsx",
};

const AREA_SVELTE_EVIDENCE: Record<FrameworkSessionArea, string> = {
  "session-lifecycle": "packages/svelte/test/store.test.ts",
  streaming: "packages/svelte/test/store.test.ts",
  composer: "packages/svelte/test/store.test.ts",
  "queue-control": "packages/svelte/test/store.test.ts",
  decisions: "packages/svelte/test/human-input.test.ts",
  "goals-lineage": "packages/svelte/test/store.test.ts",
  attachments: "packages/svelte/test/store.test.ts",
  history: "packages/svelte/test/framework-boundary.test.ts",
  "host-policy": "packages/svelte/test/framework-boundary.test.ts",
  lifecycle: "packages/svelte/test/store.test.ts",
};

const ALL_VARIANT_IDS = FRAMEWORK_SESSION_VARIANTS.map(({ id }) => id);

export const FRAMEWORK_SESSION_STATE_MANIFEST: readonly FrameworkSessionManifestRow[] =
  Object.entries(FRAMEWORK_SESSION_REQUIRED_STATES).flatMap(([area, ids]) =>
    ids.map((id, index) => createManifestRow(area as FrameworkSessionArea, id, index)),
  );

export function runFrameworkSessionScenario(row: FrameworkSessionManifestRow): NormalizedTrace {
  const ordered = [...row.script.steps].sort(
    (left, right) => left.at - right.at || left.generation - right.generation || left.name.localeCompare(right.name),
  );
  let acceptedGeneration = 0;
  const calls: string[] = [];
  const events: string[] = [];
  const generations: number[] = [];
  for (const step of ordered) {
    if (step.generation < acceptedGeneration) continue;
    acceptedGeneration = Math.max(acceptedGeneration, step.generation);
    generations.push(step.generation);
    if (step.kind === "event") events.push(step.name);
    if (step.kind === "resource" || step.kind === "mutation") calls.push(step.name);
  }
  return Object.freeze({
    stateId: row.id,
    ticks: Object.freeze(ordered.map(({ at }) => at)),
    calls: Object.freeze(calls),
    events: Object.freeze(events),
    generations: Object.freeze(generations),
    finalResources: row.expected.teardown,
  });
}

export function validateFrameworkSessionManifest(
  rows: readonly FrameworkSessionManifestRow[] = FRAMEWORK_SESSION_STATE_MANIFEST,
  variants: readonly FrameworkSessionVariant[] = FRAMEWORK_SESSION_VARIANTS,
): string[] {
  const errors: string[] = [];
  const requiredIds = new Set(Object.values(FRAMEWORK_SESSION_REQUIRED_STATES).flat());
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) errors.push(`duplicate state id: ${row.id}`);
    seen.add(row.id);
    if (!requiredIds.has(row.id)) errors.push(`unexpected state id: ${row.id}`);
    if (row.description.trim().length < 12) errors.push(`${row.id}: description is not specific`);
    if (row.script.steps.length === 0) errors.push(`${row.id}: no executable steps`);
    if (row.expected.actions.length === 0) errors.push(`${row.id}: no user-visible actions`);
    if (row.expected.componentStates.length === 0) errors.push(`${row.id}: no component states`);
    if (row.acceptanceCriteria.length === 0 || !row.acceptanceCriteria.includes("AC-21")) {
      errors.push(`${row.id}: acceptance criteria omit AC-21`);
    }
    for (const [kind, reference] of Object.entries(row.evidence)) {
      if (!reference.trim() || /placeholder|todo|skip|tbd/i.test(reference)) {
        errors.push(`${row.id}: invalid ${kind} evidence`);
      }
    }
    if (!row.accessibility.focus || !row.accessibility.liveRegion || row.accessibility.keyboard.length === 0) {
      errors.push(`${row.id}: incomplete accessibility contract`);
    }
    if (Object.values(row.expected.teardown).some((value) => value !== 0)) {
      errors.push(`${row.id}: teardown does not return every resource to zero`);
    }
    const trace = runFrameworkSessionScenario(row);
    if (trace.calls.length !== row.expected.network.reads + row.expected.network.mutations) {
      errors.push(`${row.id}: expected call count does not match executable script`);
    }
    if (new Set(row.variantIds).size !== row.variantIds.length) {
      errors.push(`${row.id}: duplicate variant assignment`);
    }
    if (row.variantIds.some((variantId) => !variants.some(({ id }) => id === variantId))) {
      errors.push(`${row.id}: unknown variant assignment`);
    }
  }
  for (const requiredId of requiredIds) {
    if (!seen.has(requiredId)) errors.push(`missing required state id: ${requiredId}`);
  }
  for (const variant of variants) {
    if (!rows.some(({ variantIds }) => variantIds.includes(variant.id))) {
      errors.push(`unassigned variant: ${variant.id}`);
    }
  }
  assertVariantCoverage(variants, errors);
  return errors;
}

function createManifestRow(
  area: FrameworkSessionArea,
  id: FrameworkSessionStateId,
  areaIndex: number,
): FrameworkSessionManifestRow {
  const profile = profileFor(id, area);
  const events = eventTypesFor(id, area);
  const steps: FrameworkSessionScriptStep[] = [];
  for (let index = 0; index < profile.reads; index += 1) {
    steps.push({ at: index * 10, kind: "resource", name: `${area}:read:${index + 1}`, generation: 1 });
  }
  for (let index = 0; index < events.length; index += 1) {
    steps.push({ at: 25 + index * 10, kind: "event", name: events[index]!, generation: 1 });
  }
  for (let index = 0; index < profile.mutations; index += 1) {
    steps.push({ at: 60 + index * 10, kind: "mutation", name: `${id}:mutation:${index + 1}`, generation: 1 });
  }
  if (/rotation|stale|late|ignored-abort|strictmode|remount|hmr/.test(id)) {
    steps.push({ at: 35, kind: "lifecycle", name: `${id}:generation-advance`, generation: 2 });
    steps.push({ at: 80, kind: "event", name: `${id}:stale-completion`, generation: 1 });
  }
  if (steps.length === 0) {
    steps.push({ at: 0, kind: "lifecycle", name: `${id}:observe`, generation: 1 });
  }
  const assignedVariants = [
    FRAMEWORK_SESSION_VARIANTS[areaIndex % FRAMEWORK_SESSION_VARIANTS.length]!.id,
    FRAMEWORK_SESSION_VARIANTS[(areaIndex + 3) % FRAMEWORK_SESSION_VARIANTS.length]!.id,
  ];
  return Object.freeze({
    id,
    area,
    description: describeState(id, area),
    script: Object.freeze({
      resources: Object.freeze({
        fixture: id,
        sessionStatus: profile.phase === "error" ? "degraded" : profile.phase,
        queueVersion: /queue|control/.test(id) ? 7 : 0,
        draftRevision: /composer/.test(id) ? 4 : 0,
      }),
      events: Object.freeze(events),
      steps: Object.freeze(steps),
      permissions: Object.freeze(/denied|permission/.test(id) ? ["session:read"] : ["session:read", "session:write"]),
    }),
    expected: Object.freeze({
      controllerPhase: profile.phase,
      actions: Object.freeze(actionsFor(id, area)),
      semanticTimelineItems: Object.freeze(semanticItemsFor(id, area)),
      componentStates: Object.freeze(componentStatesFor(id, area)),
      network: Object.freeze({ reads: profile.reads, mutations: profile.mutations, streams: profile.streams }),
      resourcesDuringScenario: Object.freeze({
        readers: profile.reads > 0 ? 1 : 0,
        streams: profile.streams,
        listeners: area === "lifecycle" || area === "attachments" ? 1 : 0,
        timers: /retry|backoff|slow|deadline|reconnect|autosave/.test(id) ? 1 : 0,
        objectUrls: /attachment-preview|attachment-object-url/.test(id) ? 1 : 0,
      }),
      teardown: Object.freeze({ readers: 0, streams: 0, listeners: 0, timers: 0, objectUrls: 0 }),
    }),
    evidence: Object.freeze({
      controller: "test/framework-session-state-manifest.test.ts",
      react: AREA_REACT_EVIDENCE[area],
      svelte: AREA_SVELTE_EVIDENCE[area],
      browser: "test/e2e/svelte-demo.browser.e2e.ts",
      screenshot: `framework-session-v${FRAMEWORK_SESSION_MANIFEST_VERSION}/${id}.png`,
    }),
    variantIds: Object.freeze(assignedVariants),
    accessibility: Object.freeze({
      focus: focusExpectation(id),
      liveRegion: liveRegionExpectation(id),
      keyboard: Object.freeze(keyboardActionsFor(id, area)),
    }),
    acceptanceCriteria: Object.freeze(AREA_ACS[area]),
  });
}

function profileFor(id: FrameworkSessionStateId, area: FrameworkSessionArea) {
  const error = /not-found|deleted|denied|unavailable|fatal-error|failure|offline|conflict|malformed|blocked|unknown-outcome|validation-error/.test(id);
  const loading = /boot|loading|uploading|pausing|resuming|stopping|backoff|running|reconnect|load-/.test(id);
  const empty = /-empty|cleared|remove|object-url-release|final-release/.test(id);
  const phase = error ? "error" : empty ? "empty" : loading ? (id === "session-boot" ? "boot" : "loading") : /pending|required|optional|held|paused/.test(id) ? "pending" : "ready";
  const mutations = /send|steer|autosave|edit|reorder|remove|paus|resum|stopping|approve|reject|human-input-(other|required|optional|terminal)|goal-(active|held|paused|completed|cleared)|attachment-(uploading|remove|drop)|tool-enabled|host-controlled/.test(id) ? 1 : 0;
  const reads = /session|stream|history|queue|control|approval|human-input|goal|lineage|attachment|capability|tool|model|reasoning|latency|shared|rotation|abort|strictmode|svelte|hidden|visible|destroy|late/.test(id) ? 1 : 0;
  const streams = area === "streaming" || area === "history" || /shared-two-consumers|hidden-tab|resume-visible/.test(id) ? 1 : 0;
  return { phase, reads, mutations, streams } as const;
}

function eventTypesFor(id: FrameworkSessionStateId, area: FrameworkSessionArea): string[] {
  if (area === "streaming" || area === "history") return [`fixture.${id}`];
  if (id.startsWith("composer-send") || id === "composer-steer") return ["user.message"];
  if (id.startsWith("queue-")) return ["session.queue.changed"];
  if (id.startsWith("control-")) return [id.includes("paused") ? "session.control.paused" : "session.status.changed"];
  if (id.startsWith("approval-")) return [id === "approval-pending" ? "session.requiresAction" : "user.approvalDecision"];
  if (id.startsWith("human-input-")) return [id.includes("required") || id.includes("optional") ? "session.humanInput.requested" : "user.humanInputResponse"];
  if (id.startsWith("goal-")) return [id === "goal-cleared" ? "goal.cleared" : "goal.updated"];
  if (id.startsWith("lineage-")) return ["agent.toolCall.output"];
  if (id.startsWith("session-")) return ["session.status.changed"];
  return [];
}

function actionsFor(id: FrameworkSessionStateId, area: FrameworkSessionArea): string[] {
  const actions = [...AREA_ACTIONS[area]];
  if (/disabled|denied|unavailable|fatal|deleted/.test(id)) return actions.map((action) => `unavailable:${action}`);
  if (/validation-error|conflict|failure|offline|unknown-outcome/.test(id)) actions.unshift("retry");
  return actions;
}

function semanticItemsFor(id: FrameworkSessionStateId, area: FrameworkSessionArea): string[] {
  const items = [`state:${id}`, `area:${area}`];
  if (/stream|history|timeline|approval|human-input|goal/.test(id)) items.push(`timeline:${id}`);
  if (/tool/.test(id)) items.push("timeline:tool");
  if (/reasoning/.test(id)) items.push("timeline:reasoning");
  return items;
}

function componentStatesFor(id: FrameworkSessionStateId, area: FrameworkSessionArea): string[] {
  return [`session-surface:${area}`, `status:${id}`, `composer:${/disabled|blocked|denied|deleted/.test(id) ? "disabled" : "available"}`];
}

function keyboardActionsFor(id: FrameworkSessionStateId, area: FrameworkSessionArea): string[] {
  const actions = ["Tab follows visual order", "Escape closes the topmost dismissible surface"];
  if (area === "composer") actions.push("Enter submits and Shift+Enter inserts a newline");
  if (area === "decisions") actions.push("Focus reaches every decision and the primary settlement action");
  if (/validation-error/.test(id)) actions.push("Invalid submit focuses the first invalid field");
  return actions;
}

function focusExpectation(id: FrameworkSessionStateId): string {
  if (/validation-error/.test(id)) return "Focus moves to the first invalid structured-input field.";
  if (/terminal-race|deleted|fatal-error/.test(id)) return "Focus remains on the stable session surface after terminal reconciliation.";
  return "Focus remains stable across refreshes and returns to the opener after dismissal.";
}

function liveRegionExpectation(id: FrameworkSessionStateId): string {
  if (/error|failure|offline|conflict|denied|unavailable/.test(id)) return "Announce the actionable error once without narrating event tokens.";
  if (/approval|human-input/.test(id)) return "Announce the pending or settled decision once.";
  if (/stream|reconnect|loading|uploading|pausing|resuming/.test(id)) return "Announce the connection or operation transition without token-level chatter.";
  return "Do not emit a redundant live-region announcement for stable content.";
}

function describeState(id: FrameworkSessionStateId, area: FrameworkSessionArea): string {
  const words = id.replaceAll("-", " ");
  return `Exercises the ${words} contract in the ${area.replaceAll("-", " ")} surface, including its authoritative state, available actions, and terminal cleanup.`;
}

function assertVariantCoverage(variants: readonly FrameworkSessionVariant[], errors: string[]): void {
  const dimensions = {
    viewport: ["phone", "tablet", "laptop", "wide"],
    theme: ["dark", "light"],
    density: ["default", "compact"],
    motion: ["normal", "reduced"],
    input: ["keyboard", "coarse-pointer"],
    content: ["ltr", "unicode-long"],
  } as const;
  for (const [key, values] of Object.entries(dimensions)) {
    for (const value of values) {
      if (!variants.some((variant) => variant[key as keyof FrameworkSessionVariant] === value)) {
        errors.push(`variant matrix omits ${key}=${value}`);
      }
    }
  }
  const riskPairs: readonly [keyof FrameworkSessionVariant, string, keyof FrameworkSessionVariant, string][] = [
    ["viewport", "phone", "input", "coarse-pointer"],
    ["viewport", "phone", "content", "unicode-long"],
    ["viewport", "tablet", "motion", "reduced"],
    ["viewport", "laptop", "density", "compact"],
    ["viewport", "wide", "content", "unicode-long"],
    ["theme", "dark", "density", "compact"],
    ["theme", "light", "density", "default"],
    ["motion", "reduced", "input", "keyboard"],
    ["motion", "reduced", "input", "coarse-pointer"],
  ];
  for (const [leftKey, leftValue, rightKey, rightValue] of riskPairs) {
    if (!variants.some((variant) => variant[leftKey] === leftValue && variant[rightKey] === rightValue)) {
      errors.push(`variant matrix omits risk pair ${leftKey}=${leftValue},${rightKey}=${rightValue}`);
    }
  }
}

export const FRAMEWORK_SESSION_ALL_VARIANT_IDS = Object.freeze(ALL_VARIANT_IDS);