import { OpenGeniApiError } from "@opengeni/sdk";

import type { GitHubCapabilityHealth } from "@/types";

/** Collapse transport/provider failures into a secret-safe recovery state. */
export function githubCapabilityHealthForError(error: unknown): GitHubCapabilityHealth {
  if (error instanceof OpenGeniApiError) {
    if (error.status === 409) {
      return {
        state: "unavailable",
        reason: "not_configured",
        action: "configure",
        renewal: "inactive",
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        state: "unavailable",
        reason: "permission_denied",
        action: "retry",
        renewal: "inactive",
      };
    }
    if (error.status >= 500) {
      return {
        state: "unavailable",
        reason: "provider_unavailable",
        action: "retry",
        renewal: "inactive",
      };
    }
  }
  return {
    state: "unavailable",
    reason: "unknown",
    action: "retry",
    renewal: "inactive",
  };
}
