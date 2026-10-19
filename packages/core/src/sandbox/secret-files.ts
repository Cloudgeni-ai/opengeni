import {
  registerConnectedSecretScope,
  requestConnectedSecretScopeClose,
  completeConnectedSecretScope,
  type ConnectedSecretOwner,
  type Database,
} from "@opengeni/db";
import type { SelfhostedSecretFileLifecycle } from "@opengeni/runtime/sandbox";

/** Capture exact attempt ownership; cleanup never borrows a successor's grant. */
export function connectedSecretFileLifecycle(
  db: Database,
  owner: ConnectedSecretOwner,
): SelfhostedSecretFileLifecycle {
  return async (target) => {
    const id = await registerConnectedSecretScope(db, owner, target);
    return {
      close: async () => await requestConnectedSecretScopeClose(db, owner, id),
      complete: async () => await completeConnectedSecretScope(db, owner, id),
    };
  };
}
