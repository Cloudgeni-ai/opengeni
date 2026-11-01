import { asVaultClient, vaultsApi, type VaultAvailability, type VaultSummary } from "@opengeni/sdk";
import { isPermissionDenied, userErrorText } from "@opengeni/react/ui/api-error";

import {
  AVAILABLE_LOADERS,
  sortThings,
  vaultState,
  type AvailableHereClient,
  type AvailableThing,
} from "./available-here-model";

/* ----------------------------------------------------------------------------
   Organization settings › Shared: everything the organization shares with
   its workspaces, and where each works.

   The organization's machines, rigs, Skills and Knowledge work in every
   workspace, Personal workspaces included, so the lists of the workspace the
   page is anchored on hold all of them: the same loaders Available here uses,
   kept to what the organization owns. Organization vaults work only where
   their "Available in" says, so they come from the organization vault list,
   which holds them wherever they work. Someone who may not read that list (an
   admin who isn't an owner), or a server that can't list them all yet, gets
   the ones that work here, and the page says so.
   -------------------------------------------------------------------------- */

export type SharedOverviewClient = AvailableHereClient;

/** The kinds of thing that work in every workspace, in page order. */
export const EVERYWHERE_KINDS = ["machine", "rig", "skills", "knowledge"] as const;
export type SharedKind = (typeof EVERYWHERE_KINDS)[number] | "vault";

export type SharedVault = {
  id: string;
  name: string;
  /** "Sign-in expired"; null when all is well. */
  state: string | null;
  availability: VaultAvailability | null;
};

/**
 * Which organization vaults the list holds: all of them; only the ones that
 * work here because only organization owners and admins may list them all; or only the
 * ones that work here because the server can't list the rest yet.
 */
export type VaultCoverage = "all" | "here-owners-see-all" | "here";

export type SharedOverviewResult = {
  everywhere: AvailableThing[];
  vaults: SharedVault[];
  vaultCoverage: VaultCoverage;
  /** Kinds whose list failed for a reason other than permission. */
  failed: SharedKind[];
  failureMessage: string | null;
};

function sharedVault(vault: VaultSummary): SharedVault {
  return {
    id: vault.id,
    name: vault.name,
    state: vaultState(vault),
    availability: vault.availability,
  };
}

async function organizationVaults(
  client: SharedOverviewClient,
  workspaceId: string,
): Promise<{ vaults: SharedVault[]; coverage: VaultCoverage }> {
  const api = vaultsApi(asVaultClient(client), workspaceId);
  try {
    const listed = await api.listOrganizationVaults();
    return {
      vaults: listed.vaults.filter((vault) => vault.ownerKind === "organization").map(sharedVault),
      coverage: listed.complete ? "all" : "here",
    };
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
    const here = await api.listVaults();
    return {
      vaults: here.filter((vault) => vault.ownerKind === "organization").map(sharedVault),
      coverage: "here-owners-see-all",
    };
  }
}

async function everywhere(
  client: SharedOverviewClient,
  workspaceId: string,
  kind: (typeof EVERYWHERE_KINDS)[number],
): Promise<AvailableThing[]> {
  const things =
    kind === "knowledge"
      ? await AVAILABLE_LOADERS.knowledge(client, workspaceId, ["organization"])
      : await AVAILABLE_LOADERS[kind](client, workspaceId);
  return things.filter((thing) => thing.owner === "organization");
}

export async function loadSharedOverview(
  client: SharedOverviewClient,
  workspaceId: string,
): Promise<SharedOverviewResult> {
  const [vaultResult, ...kindResults] = await Promise.allSettled([
    organizationVaults(client, workspaceId),
    ...EVERYWHERE_KINDS.map((kind) => everywhere(client, workspaceId, kind)),
  ]);
  const failed: SharedKind[] = [];
  let failureMessage: string | null = null;
  const fail = (kind: SharedKind, reason: unknown) => {
    // Someone who may not read a kind simply doesn't see it.
    if (isPermissionDenied(reason)) return;
    failed.push(kind);
    failureMessage ??= userErrorText(reason, "The service didn't answer.");
  };

  let vaults: SharedVault[] = [];
  let vaultCoverage: VaultCoverage = "all";
  if (vaultResult!.status === "fulfilled") {
    vaults = vaultResult!.value.vaults;
    vaultCoverage = vaultResult!.value.coverage;
  } else {
    fail("vault", vaultResult!.reason);
  }
  const things: AvailableThing[] = [];
  kindResults.forEach((result, index) => {
    if (result.status === "fulfilled") things.push(...result.value);
    else fail(EVERYWHERE_KINDS[index]!, result.reason);
  });
  return {
    everywhere: sortThings(things),
    vaults: [...vaults].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    ),
    vaultCoverage,
    failed,
    failureMessage,
  };
}

/* ----------------------------------------------------------------------------
   Where a vault works, and where its row opens.
   -------------------------------------------------------------------------- */

export type SharedPlace = {
  /** The workspace the page is anchored on. */
  workspaceId: string;
  workspaceName: string;
  personal: boolean;
  /** The organization's shared workspaces, for names. */
  workspaces: readonly { id: string; name: string }[];
  /** Workspaces the viewer can open. */
  accessibleWorkspaceIds: ReadonlySet<string>;
  /** The viewer's own Personal workspace in this organization, if they have one. */
  personalWorkspaceId: string | null;
};

/**
 * Whether a vault works in a workspace, as the server decides it: a Personal
 * workspace follows the "Include personal workspaces" switch, a shared one
 * the workspace list (none is every shared workspace).
 */
export function vaultWorksIn(
  availability: VaultAvailability | null,
  workspace: { id: string; personal: boolean },
): boolean {
  if (!availability) return true;
  if (workspace.personal) return availability.allowPersonalWorkspaces;
  return (
    availability.allowedWorkspaceIds === null ||
    availability.allowedWorkspaceIds.includes(workspace.id)
  );
}

function joined(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** At most this many workspace names; the rest are counted. */
const NAMED_WORKSPACES = 3;

/** "Works in Design and Sales, and in Personal workspaces." */
export function vaultReachSentence(
  availability: VaultAvailability | null,
  workspaces: readonly { id: string; name: string }[],
): string {
  if (!availability) return "Works in every workspace.";
  const personal = availability.allowPersonalWorkspaces;
  if (availability.allowedWorkspaceIds === null) {
    return personal
      ? "Works in every workspace, Personal workspaces included."
      : "Works in every shared workspace, not in Personal workspaces.";
  }
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  // A deleted workspace can linger in the list; it is no longer a place.
  const names = availability.allowedWorkspaceIds
    .map((id) => byId.get(id))
    .filter((name): name is string => name !== undefined)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  if (names.length === 0) {
    return personal ? "Works only in Personal workspaces." : "Doesn't work in any workspace yet.";
  }
  const listed =
    names.length <= NAMED_WORKSPACES + 1
      ? joined(names)
      : `${names.slice(0, NAMED_WORKSPACES).join(", ")} and ${names.length - NAMED_WORKSPACES} more`;
  return personal ? `Works in ${listed}, and in Personal workspaces.` : `Works in ${listed}.`;
}

/** Where a vault's row opens: a workspace it works in, or nowhere the viewer can go. */
export type VaultOpen = { workspaceId: string; workspaceName: string | null } | null;

/**
 * The anchored workspace when the vault works there (name null: no need to say
 * it); otherwise the first workspace by name that it works in and the viewer
 * can open, then the viewer's Personal workspace.
 */
export function vaultOpen(vault: SharedVault, place: SharedPlace): VaultOpen {
  if (vaultWorksIn(vault.availability, { id: place.workspaceId, personal: place.personal })) {
    return { workspaceId: place.workspaceId, workspaceName: null };
  }
  const shared = [...place.workspaces]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .find(
      (workspace) =>
        place.accessibleWorkspaceIds.has(workspace.id) &&
        vaultWorksIn(vault.availability, { id: workspace.id, personal: false }),
    );
  if (shared) return { workspaceId: shared.id, workspaceName: shared.name };
  if (
    place.personalWorkspaceId &&
    vaultWorksIn(vault.availability, { id: place.personalWorkspaceId, personal: true })
  ) {
    return { workspaceId: place.personalWorkspaceId, workspaceName: "your Personal workspace" };
  }
  return null;
}

/** The vault row's sentence: where it works, then where it opens when that's elsewhere. */
export function vaultDescription(vault: SharedVault, place: SharedPlace): string {
  const reach = vaultReachSentence(vault.availability, place.workspaces);
  const open = vaultOpen(vault, place);
  if (!open) return `${reach} You aren't in a workspace it works in.`;
  return open.workspaceName ? `${reach} Opens in ${open.workspaceName}.` : reach;
}

/** The Vaults group's description: where they work, who manages them, and what the list holds. */
export function vaultsDescription(coverage: VaultCoverage, place: SharedPlace): string {
  const here = place.personal ? "your Personal workspace" : place.workspaceName;
  const reach = "Each works only where its Available in says.";
  switch (coverage) {
    case "all":
      return `${reach} Organization owners and admins manage them.`;
    case "here":
      return `${reach} Organization owners and admins manage them. Here are the ones that work in ${here}.`;
    case "here-owners-see-all":
      return `${reach} Organization owners and admins manage them and see every one; here are the ones that work in ${here}.`;
  }
}

/** "Couldn't load machines and vaults." */
export function sharedFailedSentence(failed: readonly SharedKind[]): string {
  const words: Record<SharedKind, string> = {
    machine: "machines",
    rig: "rigs",
    skills: "Skills",
    knowledge: "Knowledge",
    vault: "vaults",
  };
  return `Couldn't load ${joined(failed.map((kind) => words[kind]))}.`;
}
