import { z } from "zod";
import type { ToolResult } from "@trycua/cua-driver";
import { ComputerBackendError, type ComputerBackendErrorCode } from "../computer-backend";

/** Only the desktop tool seam is exposed. Browser tools never enter this adapter. */
export interface CuaDesktopRuntime {
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
      }),
    )
    .max(4096),
});
export const Element = z.object({
  element_index: id,
  element_token: z.string().max(256).optional(),
  parent_index: id.optional(),
  role: text,
  label: text.optional(),
  value: z.union([text, z.number().finite(), z.boolean()]).optional(),
  enabled: z.boolean().optional(),
  focused: z.boolean().optional(),
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
  screenshot_width: id.optional(),
  screenshot_height: id.optional(),
  screenshot_frame_valid: z.boolean().optional(),
  screenshot_mime_type: text.optional(),
});

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
};

/** A failed/partial mutation is ambiguous unless CUA explicitly proves refusal. */
export async function callDesktop(
  runtime: CuaDesktopRuntime,
  name: string,
  args: Record<string, unknown>,
  mutation = false,
): Promise<{ data: Record<string, unknown>; result: ToolResult }> {
  let result: ToolResult;
  let data: Record<string, unknown>;
  try {
    result = await runtime.callTool(name, JSON.stringify(args));
    if (!result.structuredJson || result.structuredJson.length > 8 * 1024 * 1024)
      throw new Error("invalid envelope");
    data = z.record(z.string(), z.unknown()).parse(JSON.parse(result.structuredJson));
  } catch {
    throw new ComputerBackendError(
      mutation ? "outcome_unknown" : "driver_failed",
      `CUA ${name} did not return a valid result`,
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
    const refused = effect === "refused";
    const code = refusal.success
      ? refusal.data.code
      : error.success
        ? error.data.code
        : typeof data.code === "string"
          ? data.code
          : result.errorCode;
    const mapped = code ? errorCodes[code] : undefined;
    throw new ComputerBackendError(
      mutation && !refused ? "outcome_unknown" : (mapped ?? "driver_failed"),
      `CUA ${name} ${refused ? "refused the operation" : "did not establish completion"}`,
      false,
      mutation && !refused,
    );
  }
  if (mutation && effect !== "confirmed" && effect !== "unverifiable") {
    throw new ComputerBackendError(
      "outcome_unknown",
      `CUA ${name} returned no action disposition`,
      false,
      true,
    );
  }
  return { data, result };
}
