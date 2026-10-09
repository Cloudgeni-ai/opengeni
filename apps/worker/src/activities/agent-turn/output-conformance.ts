export const PROVIDER_OUTPUT_PROTOCOL_VIOLATION_CODE = "provider_output_protocol_violation";

export type LeakedTranscriptMarker = "assistant_tool_target" | "assistant_internal" | "tool_result";

export type LeakedTranscriptViolation = {
  markers: LeakedTranscriptMarker[];
};

const TRANSCRIPT_MARKER =
  /(?:^|\r?\n)[ \t]*\[(Assistant[ \t]+to=[^\]\r\n]{1,256}|Assistant(?:\/|[ \t]+)(?:analysis|commentary|final)|Tool(?:\/analysis)?)\]/g;
const TRANSCRIPT_CANDIDATE =
  /(?:^|\r?\n)[ \t]*\[(?:Assistant[ \t]+to=|Assistant(?:\/|[ \t]+)(?:analysis|commentary|final)\]|Tool(?:\/analysis)?\])/;
const STREAM_HOLDBACK_CHARS = 64;
const MAX_QUARANTINED_CANDIDATE_CHARS = 128 * 1024;

function markerKind(marker: string): LeakedTranscriptMarker {
  if (/^Assistant[ \t]+to=/.test(marker)) return "assistant_tool_target";
  if (/^Assistant(?:\/|[ \t]+)/.test(marker)) return "assistant_internal";
  return "tool_result";
}

/**
 * Detect a provider response that rendered an internal agent/tool transcript as
 * assistant prose instead of returning structured tool-call items. Requiring a
 * tool-target marker plus a second internal-role marker keeps ordinary prose and
 * isolated documentation examples out of the failure path.
 */
export function detectLeakedAgentTranscript(text: string): LeakedTranscriptViolation | null {
  const markers = new Set<LeakedTranscriptMarker>();
  TRANSCRIPT_MARKER.lastIndex = 0;
  for (const match of text.matchAll(TRANSCRIPT_MARKER)) {
    markers.add(markerKind(match[1]!));
  }
  if (
    !markers.has("assistant_tool_target") ||
    (!markers.has("assistant_internal") && !markers.has("tool_result"))
  ) {
    return null;
  }
  return { markers: [...markers] };
}

export class ProviderOutputProtocolViolationError extends Error {
  readonly code = PROVIDER_OUTPUT_PROTOCOL_VIOLATION_CODE;

  constructor(
    readonly violation: LeakedTranscriptViolation,
    readonly structuredToolActivityObserved: boolean,
  ) {
    super("Model provider returned an internal agent transcript as assistant text");
    this.name = "ProviderOutputProtocolViolationError";
  }
}

export type GuardedAssistantDelta = {
  text: string;
  violation: LeakedTranscriptViolation | null;
};

/**
 * Keep only a small suffix of normal text, but quarantine a transcript-shaped
 * candidate until it is either confirmed or the message ends. This preserves
 * ordinary streaming while ensuring marker sequences split across token deltas
 * never reach the durable event stream.
 */
export class AssistantOutputConformanceGuard {
  private buffered = "";
  private quarantining = false;

  push(text: string): GuardedAssistantDelta {
    if (text.length === 0) return { text: "", violation: null };
    this.buffered += text;

    if (!this.quarantining) {
      const candidate = TRANSCRIPT_CANDIDATE.exec(this.buffered);
      TRANSCRIPT_CANDIDATE.lastIndex = 0;
      if (candidate) {
        this.quarantining = true;
        const candidateStart = candidate.index;
        const safeText = this.buffered.slice(0, candidateStart);
        this.buffered = this.buffered.slice(candidateStart);
        return {
          text: safeText,
          violation: detectLeakedAgentTranscript(this.buffered),
        };
      }

      const releaseLength = Math.max(0, this.buffered.length - STREAM_HOLDBACK_CHARS);
      const safeText = this.buffered.slice(0, releaseLength);
      this.buffered = this.buffered.slice(releaseLength);
      return { text: safeText, violation: null };
    }

    const violation = detectLeakedAgentTranscript(this.buffered);
    if (violation) return { text: "", violation };

    // A lone marker can be a quoted example. Bound how much such an example can
    // delay before treating it as ordinary text and resuming suffix inspection.
    if (this.buffered.length > MAX_QUARANTINED_CANDIDATE_CHARS) {
      const safeText = this.buffered.slice(0, -STREAM_HOLDBACK_CHARS);
      this.buffered = this.buffered.slice(-STREAM_HOLDBACK_CHARS);
      this.quarantining = false;
      return { text: safeText, violation: null };
    }

    return { text: "", violation: null };
  }

  finish(): GuardedAssistantDelta {
    const text = this.buffered;
    const violation = detectLeakedAgentTranscript(text);
    this.buffered = "";
    this.quarantining = false;
    return { text: violation ? "" : text, violation };
  }
}
