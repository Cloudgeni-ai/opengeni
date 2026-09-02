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
  /** File a newly created session in this workspace folder. */
  channelId?: string;
  /** One installed session-selected Skill to freeze onto the new session. */
  skillCapabilityId?: string;
};

/** Stable empty search — safe default prop (no per-render object literal). */
export const EMPTY_COMPOSER_LAUNCH: ComposerLaunchSearch = {};

export function parseComposerLaunchSearch(search: Record<string, unknown>): ComposerLaunchSearch {
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
  if (
    typeof search.channelId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      search.channelId,
    )
  ) {
    out.channelId = search.channelId;
  }
  if (typeof search.skillCapabilityId === "string") {
    const skillCapabilityId = search.skillCapabilityId.trim();
    if (skillCapabilityId.length > 0 && skillCapabilityId.length <= 512) {
      out.skillCapabilityId = skillCapabilityId;
    }
  }
  return out;
}

export function composerLaunchSearchKey(launch: ComposerLaunchSearch): string | null {
  if (
    !launch.model &&
    !launch.effort &&
    !launch.latency &&
    !launch.realtime &&
    !launch.skillCapabilityId
  )
    return null;
  return JSON.stringify({
    model: launch.model ?? null,
    effort: launch.effort ?? null,
    latency: launch.latency ?? null,
    realtime: launch.realtime ?? null,
    skillCapabilityId: launch.skillCapabilityId ?? null,
  });
}

/** Keep durable launch attachments after model/effort/latency are applied locally. */
export function composerLaunchSearchAfterPolicyApply(
  launch: ComposerLaunchSearch,
): ComposerLaunchSearch {
  return {
    ...(launch.realtime ? { realtime: launch.realtime } : {}),
    ...(launch.skillCapabilityId ? { skillCapabilityId: launch.skillCapabilityId } : {}),
  };
}
