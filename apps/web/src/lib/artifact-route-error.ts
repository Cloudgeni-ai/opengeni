import { OpenGeniApiError } from "@opengeni/sdk";

export type ArtifactRouteErrorKind = "site" | "editable";

export type ArtifactRouteErrorView = Readonly<{
  title: string;
  message: string;
  retryable: boolean;
  correlationId?: string;
}>;

const COPY = {
  site: {
    unavailable: {
      title: "This Site isn't available",
      message: "It may have been removed, or you may not have access.",
    },
    invalid: {
      title: "This Site link isn't valid",
      message: "Check the address and open a Site from your workspace library.",
    },
    transient: {
      title: "Couldn't load this Site",
      message: "A temporary problem prevented this Site from loading. Try again.",
    },
  },
  editable: {
    unavailable: {
      title: "This artifact isn't available",
      message: "It may have been removed, or you may not have access.",
    },
    invalid: {
      title: "This artifact link isn't valid",
      message: "Check the address and open the artifact from your workspace library.",
    },
    transient: {
      title: "Could not open this artifact",
      message: "A temporary problem prevented this artifact from opening. Try again.",
    },
  },
} as const;

function isUnavailableStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

/** Route-scoped Site/editor load copy. Never surfaces raw OpenGeni API status text. */
export function mapArtifactRouteError(
  error: unknown,
  kind: ArtifactRouteErrorKind,
): ArtifactRouteErrorView {
  const copy = COPY[kind];
  const correlationId = error instanceof OpenGeniApiError ? error.correlationId : undefined;
  const withSupport = (view: {
    title: string;
    message: string;
    retryable: boolean;
  }): ArtifactRouteErrorView => (correlationId ? { ...view, correlationId } : view);

  if (error instanceof OpenGeniApiError) {
    if (isUnavailableStatus(error.status)) {
      return withSupport({ ...copy.unavailable, retryable: false });
    }
    if (error.status === 422) {
      return withSupport({ ...copy.invalid, retryable: false });
    }
    if (error.retryable) return withSupport({ ...copy.transient, retryable: true });
    return withSupport({ ...copy.transient, retryable: false });
  }
  if (error instanceof TypeError) return { ...copy.transient, retryable: true };
  return { ...copy.transient, retryable: true };
}

export function artifactRouteErrorMessage(view: ArtifactRouteErrorView): string {
  return view.correlationId ? `${view.message} Reference: ${view.correlationId}` : view.message;
}
