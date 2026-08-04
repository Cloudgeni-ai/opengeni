import {
  LatencyMode,
  ReasoningEffort,
  SessionRealtimeModel as SessionRealtimeModelSchema,
  type SessionRealtimeModel,
} from "@opengeni/contracts";
import type { LatencyMode as LatencyModeT, ReasoningEffort as ReasoningEffortT } from "@/types";

/** Query-string composer / voice launch intent (session + sessions-index). */
export type ComposerLaunchSearch = {
  model?: string;
  effort?: ReasoningEffortT;
  latency?: LatencyModeT;
  realtime?: SessionRealtimeModel;
};

export function parseComposerLaunchSearch(
  search: Record<string, unknown>,
): ComposerLaunchSearch {
  const out: ComposerLaunchSearch = {};
  if (typeof search.model === "string") {
    const model = search.model.trim();
    if (model.length > 0) out.model = model;
  }
  const effort = ReasoningEffort.safeParse(search.effort);
  if (effort.success) out.effort = effort.data;
  const latency = LatencyMode.safeParse(search.latency);
  if (latency.success) out.latency = latency.data;
  const realtime = SessionRealtimeModelSchema.safeParse(search.realtime);
  if (realtime.success) out.realtime = realtime.data;
  return out;
}

export function composerLaunchSearchKey(launch: ComposerLaunchSearch): string | null {
  if (!launch.model && !launch.effort && !launch.latency && !launch.realtime) return null;
  return JSON.stringify({
    model: launch.model ?? null,
    effort: launch.effort ?? null,
    latency: launch.latency ?? null,
    realtime: launch.realtime ?? null,
  });
}

/** Keep only realtime after model/effort/latency have been applied locally. */
export function composerLaunchSearchAfterPolicyApply(
  launch: ComposerLaunchSearch,
): ComposerLaunchSearch {
  return launch.realtime ? { realtime: launch.realtime } : {};
}
