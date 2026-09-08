// Optional, unstyled React adapter over the shared headless controller.
// The host owns controller lifetime; unmounting one observer does not cancel an
// attempt another observer is displaying or a durable backend operation.
import { useMemo, useSyncExternalStore } from "react";
import type { ConnectController } from "@opengeni/connect";
export { ConnectSetup, type ConnectSetupProps } from "./connect-setup";
export { ConnectChooser, type ConnectChooserProps } from "./connect-chooser";
export { ConnectAccounts, type ConnectAccountsProps } from "./connect-accounts";
export { ConnectPanel, type ConnectPanelProps } from "./connect-panel";
export { DeviceAuthorization, type DeviceAuthorizationProps } from "./device-authorization";
export {
  IdentityLinkConsent,
  type IdentityLinkClient,
  type IdentityLinkConsentProps,
} from "./identity-link-consent";
export { IdentityLinkAccounts, type IdentityLinkAccountsClient } from "./identity-link-accounts";

export type { ConnectSnapshot } from "@opengeni/connect";
export type {
  ConnectAccount,
  ConnectAdvance,
  ConnectAttempt,
  ConnectNextAction,
  ConnectOwnership,
  ConnectProvider,
  ConnectResource,
  ConnectTransport,
} from "@opengeni/connect";

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
