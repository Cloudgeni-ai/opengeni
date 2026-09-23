import { lazy, Suspense } from "react";
import type { PersonalResourceAttachmentController } from "@/lib/use-personal-resource-attachment";
import { FailureRecoveryBoundary } from "./session/failure-recovery-boundary";
const LazyControl = lazy(() =>
  import("./personal-resource-attachment-control").then((module) => ({
    default: module.PersonalResourceAttachmentControl,
  })),
);

export function PersonalResourceAttachmentSurface(props: {
  controller: PersonalResourceAttachmentController;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { controller } = props;
  if (
    !controller.eligible ||
    !(controller.error || controller.notice || controller.loading || controller.truncated)
  )
    return null;
  const blocked = controller.error
    ? " The selected resource is unavailable; sending remains blocked."
    : null;
  return (
    <FailureRecoveryBoundary
      fallback={
        <p role="alert" className="mt-2 text-xs text-danger">
          Personal resource options are unavailable. Reload the page to review authorization.
          {blocked}
        </p>
      }
    >
      <Suspense
        fallback={
          <p role="status" className="mt-2 text-xs text-fg-subtle">
            Loading personal resource options…{blocked}
          </p>
        }
      >
        <LazyControl {...props} />
      </Suspense>
    </FailureRecoveryBoundary>
  );
}
