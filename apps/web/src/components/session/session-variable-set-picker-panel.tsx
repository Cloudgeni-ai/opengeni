import { lazy, Suspense, type ComponentProps } from "react";

import type { SessionVariableSetPicker as SessionVariableSetPickerImplementation } from "@/components/session/session-variable-set-picker";
import { ComposerMenuHeader } from "@/components/ui/composer-menu";

const LazySessionVariableSetPicker = lazy(() =>
  import("@/components/session/session-variable-set-picker").then((module) => ({
    default: module.SessionVariableSetPicker,
  })),
);

/**
 * The established-session composer mounts the Variable Set editor only after
 * "+" > Variable sets is opened. Load that editor on demand so a direct session
 * load does not carry it; the shared picker state stays in the session route.
 */
export function SessionVariableSetPicker(
  props: ComponentProps<typeof SessionVariableSetPickerImplementation>,
) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-0 flex-col gap-2">
          <ComposerMenuHeader title="Variable sets" leading={props.leading} />
          <p role="status" className="px-2 py-1 text-sm text-fg-muted">
            Loading variable sets…
          </p>
        </div>
      }
    >
      <LazySessionVariableSetPicker {...props} />
    </Suspense>
  );
}
