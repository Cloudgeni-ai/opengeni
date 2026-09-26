import { lazy, Suspense, type ComponentProps, type ComponentType, type ReactNode } from "react";

import type { SessionVariableSetPicker as SessionVariableSetPickerImplementation } from "@/components/session/session-variable-set-picker";
import { Button } from "@/components/ui/button";
import { ComposerMenuHeader } from "@/components/ui/composer-menu";

type SessionVariableSetPickerProps = ComponentProps<typeof SessionVariableSetPickerImplementation>;

/**
 * A failed editor load stays inside the menu instead of replacing the session
 * route. Only the load is caught here: `vite:preloadError` has already reported
 * it as `chunk_load`, and a render failure of the loaded editor still reaches
 * the route boundary. React keeps this result, so reopening the menu shows the
 * same notice until the page is reloaded.
 */
const LazySessionVariableSetPicker = lazy(() =>
  import("@/components/session/session-variable-set-picker")
    .then((module) => ({
      default: module.SessionVariableSetPicker as ComponentType<SessionVariableSetPickerProps>,
    }))
    .catch(() => ({ default: SessionVariableSetPickerLoadFailed })),
);

function PickerNotice(props: { leading: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <ComposerMenuHeader title="Variable sets" leading={props.leading} />
      {props.children}
    </div>
  );
}

function SessionVariableSetPickerLoadFailed(props: SessionVariableSetPickerProps) {
  return (
    <PickerNotice leading={props.leading}>
      <div
        role="alert"
        className="flex items-center justify-between gap-3 px-2 py-1 text-sm text-fg-muted"
      >
        <span>Variable sets could not be loaded.</span>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => window.location.reload()}
        >
          Reload
        </Button>
      </div>
    </PickerNotice>
  );
}

/**
 * The established-session composer mounts the Variable Set editor only after
 * "+" > Variable sets is opened. Load that editor on demand so a direct session
 * load does not carry it; the shared picker state stays in the session route.
 * Like the other composer panels this is the embedded form: the loading and
 * failure notices keep the menu header and its Back action.
 */
export function SessionVariableSetPicker(props: SessionVariableSetPickerProps) {
  return (
    <Suspense
      fallback={
        <PickerNotice leading={props.leading}>
          <p role="status" className="px-2 py-1 text-sm text-fg-muted">
            Loading variable sets…
          </p>
        </PickerNotice>
      }
    >
      <LazySessionVariableSetPicker {...props} />
    </Suspense>
  );
}
