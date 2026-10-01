// The only usage module the rail and session graphs import: two lazy
// boundaries that render nothing until the usage chunk has loaded.
import { lazy, Suspense } from "react";

const Surfaces = {
  AccountUsageMenuItem: lazy(() =>
    import("./usage-surfaces").then((module) => ({ default: module.AccountUsageMenuItem })),
  ),
  ComposerUsageNotice: lazy(() =>
    import("./usage-surfaces").then((module) => ({ default: module.ComposerUsageNotice })),
  ),
};

export function AccountUsageMenuItem(props: { workspaceId: string }) {
  return (
    <Suspense fallback={null}>
      <Surfaces.AccountUsageMenuItem {...props} />
    </Suspense>
  );
}

export function ComposerUsageNotice(props: { workspaceId: string; refreshKey?: unknown }) {
  return (
    <Suspense fallback={null}>
      <Surfaces.ComposerUsageNotice {...props} />
    </Suspense>
  );
}
