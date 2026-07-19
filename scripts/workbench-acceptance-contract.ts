export type AcceptanceEnvironment = "staging" | "production" | "cross-environment";

export type AcceptanceRequirement = {
  id: string;
  environments: readonly AcceptanceEnvironment[];
};

const staging = ["staging"] as const;
const production = ["production"] as const;
const both = ["staging", "production"] as const;
const cross = ["cross-environment"] as const;

/**
 * Machine-readable twin of docs/workbench-acceptance.md.
 *
 * Keep these identifiers broad enough that one result can carry the complete
 * boundary matrix for a contract row, but never broad enough to turn a whole
 * section into one hand-written "passed" assertion. The release validator
 * requires an immutable evidence object for every id/environment pair.
 */
export const WORKBENCH_ACCEPTANCE_REQUIREMENTS = [
  // Functional matrix.
  { id: "functional.capture-cold-path", environments: both },
  { id: "functional.capture-absence", environments: staging },
  { id: "functional.capture-degraded", environments: staging },
  { id: "functional.capture-url-expiry", environments: both },
  { id: "functional.files-tree", environments: both },
  { id: "functional.file-metadata", environments: both },
  { id: "functional.editor", environments: both },
  { id: "functional.changes", environments: both },
  { id: "functional.terminal", environments: both },
  { id: "functional.desktop", environments: staging },
  { id: "functional.machine-state", environments: both },
  { id: "functional.default-tab", environments: both },
  { id: "functional.host-tabs", environments: staging },
  { id: "functional.collapse-resize", environments: both },
  { id: "functional.notifications", environments: both },
  { id: "functional.control-cancellation", environments: both },

  // Identity and race matrix.
  { id: "identity.session-workspace-subject-transitions", environments: staging },
  { id: "identity.inflight-request-matrix", environments: staging },
  { id: "identity.timer-overlay-latch-matrix", environments: staging },
  { id: "identity.strict-mode-unmount-matrix", environments: staging },
  { id: "identity.abort-phase-matrix", environments: staging },
  { id: "identity.response-order-permutations", environments: staging },
  { id: "identity.zero-stale-dom-frames", environments: both },
  { id: "identity.zero-stale-notifications", environments: both },
  { id: "identity.current-generation-only", environments: both },
  { id: "identity.zero-cross-session-cache-keys", environments: staging },
  { id: "identity.zero-cross-session-terminal-editor", environments: staging },
  { id: "identity.zero-sensitive-residue", environments: both },
  { id: "identity.randomized-state-machine", environments: staging },

  // Scale and boundary matrix.
  { id: "scale.tree", environments: staging },
  { id: "scale.path", environments: staging },
  { id: "scale.repositories", environments: staging },
  { id: "scale.files", environments: staging },
  { id: "scale.diffs", environments: staging },
  { id: "scale.terminal", environments: staging },
  { id: "scale.events", environments: staging },
  { id: "scale.network", environments: staging },
  { id: "scale.storage", environments: staging },

  // Performance budgets. Numeric rows are checked again against hard budgets.
  { id: "performance.capture-api-response", environments: staging },
  { id: "performance.capture-usable-workbench", environments: both },
  { id: "performance.warm-session-switch", environments: staging },
  { id: "performance.interaction-feedback", environments: staging },
  { id: "performance.editor-typing", environments: staging },
  { id: "performance.tree-scroll-resize", environments: staging },
  { id: "performance.layout-shift", environments: staging },
  { id: "performance.main-thread-long-task", environments: staging },
  { id: "performance.memory", environments: staging },
  { id: "performance.network", environments: staging },
  { id: "performance.initial-asset-graph", environments: staging },
  { id: "performance.session-asset-graph", environments: staging },
  { id: "performance.lazy-javascript", environments: staging },
  { id: "performance.css", environments: staging },
  { id: "performance.control-cancellation", environments: both },

  // Accessibility and input acceptance.
  { id: "accessibility.keyboard", environments: both },
  { id: "accessibility.composite-keys", environments: staging },
  { id: "accessibility.nvda-firefox-chromium", environments: staging },
  { id: "accessibility.voiceover-macos-ios", environments: staging },
  { id: "accessibility.talkback-android", environments: staging },
  { id: "accessibility.semantics", environments: both },
  { id: "accessibility.zoom-reflow", environments: staging },
  { id: "accessibility.preferences", environments: staging },
  { id: "accessibility.contrast", environments: both },
  { id: "accessibility.touch-targets", environments: both },
  { id: "accessibility.nonvisual-meaning", environments: staging },
  { id: "accessibility.specialized-surface-alternatives", environments: staging },

  // Visual and interaction quality.
  { id: "visual.viewport-matrix", environments: staging },
  { id: "visual.preference-matrix", environments: staging },
  { id: "visual.state-matrix", environments: staging },
  { id: "visual.content-stress", environments: staging },
  { id: "visual.input-matrix", environments: staging },
  { id: "visual.zero-release-blocking-defects", environments: both },
  { id: "visual.motion", environments: staging },

  // Browser/device matrix. Real-device attestations are validated separately.
  { id: "browser.chromium-current-previous", environments: staging },
  { id: "browser.firefox-current-previous", environments: staging },
  { id: "browser.safari-current-previous", environments: staging },
  { id: "browser.edge-current-previous", environments: staging },
  { id: "browser.macos", environments: staging },
  { id: "browser.windows-nvda", environments: staging },
  { id: "browser.linux-ci", environments: staging },
  { id: "browser.ios-small-large", environments: staging },
  { id: "browser.android-midrange", environments: staging },
  { id: "browser.ipad-portrait-landscape", environments: staging },
  { id: "browser.unsupported-truthful", environments: staging },

  // Security and privacy.
  { id: "security.grant-before-parse", environments: staging },
  { id: "security.workspace-session-subject-isolation", environments: both },
  { id: "security.signed-url-scope-refresh", environments: both },
  { id: "security.path-confinement", environments: staging },
  { id: "security.mutation-permissions", environments: both },
  { id: "security.client-residue", environments: staging },
  { id: "security.deterministic-canary-content", environments: both },
  { id: "security.observability-redaction", environments: both },

  // Linear promotion contract. Package publication is verified by the release
  // workflow after this pre-publication bundle passes.
  { id: "release.exact-artifact-promotion", environments: cross },
  { id: "release.staging-complete-matrix", environments: staging },
  { id: "release.staging-soak", environments: staging },
  { id: "release.production-safe-matrix", environments: production },
  { id: "release.rollback-evidence", environments: cross },
] as const satisfies readonly AcceptanceRequirement[];

export const TIMING_SENSITIVE_REQUIREMENTS = new Set<string>([
  "identity.session-workspace-subject-transitions",
  "identity.inflight-request-matrix",
  "identity.timer-overlay-latch-matrix",
  "identity.strict-mode-unmount-matrix",
  "identity.abort-phase-matrix",
  "identity.response-order-permutations",
  "identity.zero-stale-dom-frames",
  "identity.zero-stale-notifications",
  "identity.current-generation-only",
  "identity.zero-cross-session-cache-keys",
  "identity.zero-cross-session-terminal-editor",
  "identity.zero-sensitive-residue",
  "identity.randomized-state-machine",
  "functional.control-cancellation",
  "performance.control-cancellation",
]);

export const REAL_DEVICE_REQUIREMENTS = new Set<string>([
  "accessibility.nvda-firefox-chromium",
  "accessibility.voiceover-macos-ios",
  "accessibility.talkback-android",
  "browser.macos",
  "browser.windows-nvda",
  "browser.ios-small-large",
  "browser.android-midrange",
  "browser.ipad-portrait-landscape",
]);

export type NumericBudget = {
  statistic: "p95" | "worst";
  direction: "maximum" | "minimum";
  limit: number;
  unit: "ms" | "fps" | "score" | "bytes";
};

export const NUMERIC_PERFORMANCE_BUDGETS: Readonly<Record<string, NumericBudget>> = {
  "performance.capture-api-response": {
    statistic: "p95",
    direction: "maximum",
    limit: 200,
    unit: "ms",
  },
  "performance.capture-usable-workbench": {
    statistic: "p95",
    direction: "maximum",
    limit: 500,
    unit: "ms",
  },
  "performance.warm-session-switch": {
    statistic: "p95",
    direction: "maximum",
    limit: 250,
    unit: "ms",
  },
  "performance.interaction-feedback": {
    statistic: "p95",
    direction: "maximum",
    limit: 100,
    unit: "ms",
  },
  "performance.editor-typing": {
    statistic: "p95",
    direction: "maximum",
    limit: 50,
    unit: "ms",
  },
  "performance.tree-scroll-resize": {
    statistic: "p95",
    direction: "minimum",
    limit: 55,
    unit: "fps",
  },
  "performance.layout-shift": {
    statistic: "worst",
    direction: "maximum",
    limit: 0.05,
    unit: "score",
  },
  "performance.main-thread-long-task": {
    statistic: "worst",
    direction: "maximum",
    limit: 50,
    unit: "ms",
  },
  "performance.initial-asset-graph": {
    statistic: "worst",
    direction: "maximum",
    limit: 215_040,
    unit: "bytes",
  },
  "performance.session-asset-graph": {
    statistic: "worst",
    direction: "maximum",
    limit: 552_960,
    unit: "bytes",
  },
  "performance.lazy-javascript": {
    statistic: "worst",
    direction: "maximum",
    limit: 245_760,
    unit: "bytes",
  },
  "performance.css": {
    statistic: "worst",
    direction: "maximum",
    limit: 30_720,
    unit: "bytes",
  },
  "performance.control-cancellation": {
    statistic: "worst",
    direction: "maximum",
    limit: 2_000,
    unit: "ms",
  },
};
