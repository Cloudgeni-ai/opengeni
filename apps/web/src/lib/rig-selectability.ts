import type { Rig } from "@/types";

/** Inactive Rigs have no immutable definition a new/restarted session can bind. */
export function activeSessionRigs(rigs: readonly Rig[]): Rig[] {
  return rigs.filter((rig) => rig.activeVersion !== null);
}

export function selectableSessionRigs(
  rigs: readonly Rig[],
  personalResourcesAvailable: boolean,
): Rig[] {
  return activeSessionRigs(rigs).filter(
    (rig) => rig.scope !== "user" || personalResourcesAvailable,
  );
}
