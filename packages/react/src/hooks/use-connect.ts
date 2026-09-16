import type { ConnectController } from "@opengeni/connect";
import { useMemo, useSyncExternalStore } from "react";

/** Internal consumers import the hook directly so setup surfaces stay lazy. */
export function useConnect(controller: ConnectController) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const actions = useMemo(
    () => ({
      begin: controller.begin.bind(controller),
      recover: controller.recover.bind(controller),
      refresh: controller.refresh.bind(controller),
      waitForAction: controller.waitForAction.bind(controller),
      advance: controller.advance.bind(controller),
      cancel: controller.cancel.bind(controller),
    }),
    [controller],
  );
  return useMemo(() => ({ ...snapshot, ...actions }), [snapshot, actions]);
}
