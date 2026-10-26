import { z } from "zod";
import type { ToolResult } from "@trycua/cua-driver";
import { ComputerBackendError, type ComputerBackendErrorCode } from "../computer-backend";

/** Only the desktop tool seam is exposed. Browser tools never enter this adapter. */
export interface CuaDesktopRuntime {
  listToolsJson?(): Promise<string>;
  callTool(name: string, argumentsJson: string): Promise<ToolResult>;
  shutdown(): Promise<void>;
}

const text = z.string().max(65_536);
const id = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const Rect = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});
const ElementRect = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
});
export const Windows = z.object({
  windows: z
    .array(
      z.object({
        pid: id,
        window_id: id,
        title: text,
        app_name: text,
        bounds: Rect,
        // macOS only: false for a minimized or hidden window, or one on
        // another Space or beyond every display.
        is_on_screen: z.boolean().nullish(),
        // macOS only: the Spaces the window is on; null for a window the
        // window server keeps ordered out (one no person ever sees).
        space_ids: z.array(id).max(1_024).nullish(),
        on_current_space: z.boolean().nullish(),
        // Stacking order: the highest z_index is frontmost; null when the
        // platform cannot tell. macOS also gives the window layer, where 0
        // holds ordinary app windows and higher layers menus and overlays.
        z_index: z.number().int().nullish(),
        layer: z.number().int().nullish(),
      }),
    )
    .max(4096),
});
export type ListedWindow = z.infer<typeof Windows>["windows"][number];
export const Element = z.object({
  element_index: id,
  element_token: z.string().max(256).optional(),
  parent_index: id.optional(),
  role: text,
  label: text.optional(),
  value: z.union([text, z.number().finite(), z.boolean()]).optional(),
  enabled: z.boolean().optional(),
  focused: z.boolean().optional(),
  // Whether a checkbox, switch, radio, tab or row is on or selected.
  selected: z.boolean().optional(),
  frame: ElementRect.optional(),
  actions: z.array(text).max(64).default([]),
});
export const WindowState = z.object({
  pid: id,
  window_id: id,
  snapshot_id: z.string().max(256).optional(),
  capture_id: z.string().max(256).optional(),
  window_bounds: Rect.optional(),
  elements: z.array(Element).max(2000).default([]),
  tree_markdown: z.string().max(4_000_000).optional(),
  screenshot_width: id.optional(),
  screenshot_height: id.optional(),
  screenshot_frame_valid: z.boolean().optional(),
  screenshot_mime_type: text.optional(),
  // Walk outcome: CUA returns the partial tree it has when a budget runs out.
  truncated: z.boolean().optional(),
  truncation_reason: z.string().max(64).optional(),
  nodes_pending: z.number().int().nonnegative().optional(),
});

/** How a partial CUA walk stopped, or null when CUA read the whole tree. A
 * walk that stopped for any reason other than the node cap ran out of time
 * (including an application that did not answer before the budget). */
export function walkIncompleteness(
  state: z.infer<typeof WindowState>,
): { reason: "time_budget" | "node_budget"; unreadCount: number } | null {
  if (state.truncated !== true) return null;
  return {
    reason: state.truncation_reason === "node_budget" ? "node_budget" : "time_budget",
    unreadCount: Math.min(state.nodes_pending ?? 0, 1_000_000),
  };
}

const errorCodes: Record<string, ComputerBackendErrorCode> = {
  capture_not_found: "frame_stale",
  capture_target_mismatch: "frame_stale",
  capture_stale: "frame_stale",
  capture_out_of_bounds: "invalid_action",
  stale_snapshot: "observation_stale",
  stale_element: "observation_stale",
  stale_element_token: "observation_stale",
  window_not_found: "target_not_found",
  permission_denied: "permission_denied",
  authorization_required: "permission_denied",
  unsupported: "unsupported",
  background_delivery_unsupported: "unsupported",
  background_unavailable: "unsupported",
  // The element did not take the keyboard focus; nothing else changed.
  focus_refused: "invalid_action",
  // Background keys refused before any was sent: another window of the app
  // (a sheet, a dialog) has the keyboard focus.
  window_not_key: "invalid_action",
  // Background input refused before anything was sent: the addressed element
  // could not be proven to be in the addressed window.
  element_outside_target_window: "invalid_action",
  // Pointer or key input refused before anything was sent: the element is in
  // a bubble or popover attached to the window, which takes accessibility
  // actions only.
  element_in_attached_window: "invalid_action",
  // A value write the control did not apply: it holds what it held before
  // (macOS set_value, effect not_applied).
  write_not_applied: "driver_failed",
  // A step that sets a checked state found an element that has none.
  not_a_toggle: "invalid_action",
  // A step's name fits several elements once the window settled; nothing ran.
  ambiguous: "locator_ambiguous",
  // A web <select> whose menu would bring the browser in front; nothing was
  // sent, and set_value chooses its options.
  select_menu_would_raise_window: "unsupported",
};

/** A failure CUA reported itself, with CUA's own code, so the backend can
 * recognize a refusal without reading CUA's wording. */
export class CuaFailure extends ComputerBackendError {
  constructor(
    code: ComputerBackendErrorCode,
    message: string,
    dispatched: boolean,
    readonly cuaCode: string | undefined,
  ) {
    super(code, message, false, dispatched);
  }
}

const RunStepsReport = z.object({
  ok: z.boolean().optional(),
  total: z.number().int().nonnegative().optional(),
  executed: z.number().int().nonnegative(),
  failed_step: z.number().int().nonnegative().nullish(),
  /** invalid_batch: CUA refused the whole batch before running a step. */
  code: z.string().max(256).optional(),
  detail: z.string().max(65_536).optional(),
  steps: z
    .array(
      z.object({
        ok: z.boolean().optional(),
        message: z.string().max(65_536).optional(),
        /** Where a failed step stopped: wait_for, find, action, expect or time_budget. */
        phase: z.string().max(64).optional(),
        code: z.string().max(256).optional(),
        hint: z.unknown().optional(),
        /** The window-change report lines of the step's action. */
        window_changes: z.array(z.string().max(65_536)).max(16).optional(),
        /** The element the step's lookup found. `stand_in` is set when no
         * element had the role named and the one element of a role pressed
         * alike with that exact name was used: its own role and label. */
        target: z
          .object({
            stand_in: z
              .object({ role: z.string().max(256), name: z.string().max(65_536).nullish() })
              .optional(),
          })
          .optional(),
      }),
    )
    .max(64)
    .default([]),
});

/** A step of a run_steps call whose lookup used an element of another role,
 * by the step's index in the call: the element's own role and label. */
export type RunStepsStandIn = { step: number; role: string; name: string };

/** How a CUA run_steps batch ended. */
export type RunStepsOutcome =
  | { kind: "completed"; windowChanges: string; standIns: RunStepsStandIn[] }
  | {
      kind: "stopped";
      /** The actions that completed before the one the batch stopped at. */
      completed: number;
      /** CUA proves the stopped action did nothing: it was refused, or the
       * batch stopped before acting. Otherwise it may have taken effect. */
      definite: boolean;
      code: ComputerBackendErrorCode | null;
      /** CUA's own code for the stopped action, when it gave one. */
      cuaCode: string | null;
      message: string;
      /** Of the steps that ran before the one the batch stopped at. */
      standIns: RunStepsStandIn[];
    };

/** Run actions in one CUA run_steps call: in order, stopping at the first
 * that fails. A reply that does not say how far the batch got is ambiguous. */
export async function runSteps(
  runtime: CuaDesktopRuntime,
  args: Record<string, unknown> & { steps: { tool: string; args: Record<string, unknown> }[] },
): Promise<RunStepsOutcome> {
  let result: ToolResult | undefined;
  let report: z.infer<typeof RunStepsReport>;
  try {
    result = await runtime.callTool("run_steps", JSON.stringify(args));
    if (!result.structuredJson || result.structuredJson.length > 8 * 1024 * 1024)
      throw new Error("invalid envelope");
    report = RunStepsReport.parse(JSON.parse(result.structuredJson));
  } catch {
    const reason = result?.isError && result.text.trim() ? `: ${result.text}` : "";
    throw new ComputerBackendError(
      "outcome_unknown",
      `CUA run_steps did not return a valid result${reason}`,
      false,
      true,
    );
  }
  const reply = result!;
  if (report.code === "invalid_batch") {
    const at = report.failed_step == null ? "" : ` at action ${report.failed_step + 1}`;
    throw new ComputerBackendError(
      "invalid_action",
      `CUA refused the batch${at} before running any of it: ${report.detail ?? reply.text}`,
      false,
      false,
    );
  }
  const total = args.steps.length;
  const standIns = (before: number): RunStepsStandIn[] =>
    report.steps.slice(0, before).flatMap((step, index) => {
      const used = step.target?.stand_in;
      return used?.role && used.name ? [{ step: index, role: used.role, name: used.name }] : [];
    });
  if (report.failed_step == null) {
    if (reply.isError || report.ok === false || report.executed !== total)
      throw new ComputerBackendError(
        "outcome_unknown",
        `CUA run_steps ran ${report.executed} of ${total} actions without naming a failed one`,
        false,
        true,
      );
    return {
      kind: "completed",
      windowChanges: (report.steps.at(-1)?.window_changes ?? []).join("\n"),
      standIns: standIns(total),
    };
  }
  const index = report.failed_step;
  const step = report.steps[index];
  if (index >= total || !step)
    throw new ComputerBackendError(
      "outcome_unknown",
      `CUA run_steps stopped at an action it did not report`,
      false,
      true,
    );
  const mapped = step.code ? errorCodes[step.code] : undefined;
  // Waits, lookups and the time budget stop the batch before the step acts.
  // An action CUA refused with a code it uses for refusals did nothing.
  const definite =
    step.phase === "wait_for" ||
    step.phase === "find" ||
    step.phase === "time_budget" ||
    (step.phase === "action" && mapped !== undefined);
  const hint = typeof step.hint === "string" && step.hint.trim() ? ` ${step.hint}` : "";
  return {
    kind: "stopped",
    completed: index,
    definite,
    code: mapped ?? null,
    cuaCode: step.code ?? null,
    message: `${step.message?.trim() || "CUA reported no reason"}${hint}`,
    standIns: standIns(index),
  };
}

/** CUA's own explanation of a refused or unconfirmed action (why it refused,
 * what to do instead), so the failure says more than that it failed. The text
 * is kept exactly as CUA wrote it: the computer driver redacts typed secrets
 * from it first and only then bounds its length. */
function cuaFailureReason(result: ToolResult, data: Record<string, unknown>): string | null {
  const message = (entry: unknown): unknown =>
    entry !== null && typeof entry === "object"
      ? ((entry as Record<string, unknown>).message ?? (entry as Record<string, unknown>).detail)
      : undefined;
  // Raw text, never trimmed: a typed secret can end in whitespace, and the
  // driver can only recognize it unchanged.
  const rawText = (entry: unknown): string =>
    typeof entry === "string" && entry.trim().length > 0 ? entry : "";
  const reason =
    [
      message(data.refusal),
      message(data.error),
      message(result.action?.error),
      data.message,
      data.summary,
      result.action?.summary,
      result.text,
    ]
      .map(rawText)
      .find((entry) => entry.length > 0) ?? "";
  const hint = rawText(data.hint);
  const full = hint && !reason.includes(hint) ? `${reason}${reason ? " " : ""}${hint}` : reason;
  return full.length > 0 ? full : null;
}

/** A failed/partial mutation is ambiguous unless CUA explicitly proves refusal.
 * `"caller-settles"` is a mutation whose tool reports success in its own
 * result (launch_app's pid) rather than an action disposition: failures are
 * still ambiguous, and the caller decides whether a result proves completion. */
export async function callDesktop(
  runtime: CuaDesktopRuntime,
  name: string,
  args: Record<string, unknown>,
  mode: boolean | "caller-settles" = false,
): Promise<{ data: Record<string, unknown>; result: ToolResult }> {
  const mutation = mode !== false;
  let result: ToolResult | undefined;
  let data: Record<string, unknown>;
  try {
    result = await runtime.callTool(name, JSON.stringify(args));
    if (!result.structuredJson || result.structuredJson.length > 8 * 1024 * 1024)
      throw new Error("invalid envelope");
    data = z.record(z.string(), z.unknown()).parse(JSON.parse(result.structuredJson));
  } catch {
    // Windows CUA reports a window that was not in front only as text, both
    // when it refused before sending anything (its text then says no input
    // was sent, or could be sent) and after a click it already sent.
    if (mutation && result?.isError && result.text.startsWith("foreground_unavailable:")) {
      if (
        /\bno (?:mouse |keyboard )?input was sent\b|\bbefore mouse input could be sent\b/u.test(
          result.text,
        )
      )
        throw new ComputerBackendError(
          "unavailable",
          "Windows did not keep this window in front for the input, so none of it was sent; try again",
          true,
          false,
        );
      throw new ComputerBackendError(
        "outcome_unknown",
        "The input was sent, but Windows did not keep this window in front afterwards, so its effect is unknown; observe the window before acting again",
        false,
        true,
      );
    }
    // A failure CUA reports only as text (Windows launch_app does) still says
    // why; keep it, as written, like any other CUA reason.
    const reason = result?.isError && result.text.trim() ? `: ${result.text}` : "";
    throw new ComputerBackendError(
      mutation ? "outcome_unknown" : "driver_failed",
      `CUA ${name} did not return a valid result${reason}`,
      false,
      mutation,
    );
  }
  const refusal = z.object({ code: z.string() }).safeParse(data.refusal);
  // SDK 0.30.4 rejects Mac background drag before posting any OS event.
  if (name === "drag" && result.isError && data.code === "background_unavailable") {
    throw new ComputerBackendError(
      "unsupported",
      "CUA does not support background drag on macOS",
      false,
      false,
    );
  }
  const error = z.object({ code: z.string() }).safeParse(data.error);
  const effect =
    data.effect ??
    (data.status === "refused" && refusal.success ? "refused" : result.action?.effect);
  if (
    result.isError ||
    effect === "refused" ||
    effect === "partial" ||
    effect === "suspected_noop"
  ) {
    // A write CUA reports as not applied changed nothing, like a refusal.
    const refused = effect === "refused" || effect === "not_applied";
    const code = refusal.success
      ? refusal.data.code
      : error.success
        ? error.data.code
        : typeof data.code === "string"
          ? data.code
          : result.errorCode;
    const mapped = code ? errorCodes[code] : undefined;
    const reason = cuaFailureReason(result, data);
    throw new CuaFailure(
      mutation && !refused ? "outcome_unknown" : (mapped ?? "driver_failed"),
      `CUA ${name} ${refused ? "refused the operation" : "did not establish completion"}${
        reason ? `: ${reason}` : ""
      }`,
      mutation && !refused,
      code,
    );
  }
  if (mode === true && effect !== "confirmed" && effect !== "unverifiable") {
    throw new ComputerBackendError(
      "outcome_unknown",
      `CUA ${name} returned no action disposition`,
      false,
      true,
    );
  }
  return { data, result };
}
