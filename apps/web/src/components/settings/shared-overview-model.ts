import {
  asVaultClient,
  vaultsApi,
  type OrganizationComputeReach,
  type VaultAvailability,
  type VaultSummary,
} from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { isPermissionDenied, userErrorText } from "@opengeni/react/ui/api-error";

import {
  AVAILABLE_LOADERS,
  listAllSkills,
  vaultState,
  type AvailableHereClient,
} from "./available-here-model";

/* ----------------------------------------------------------------------------
   Organization settings › Shared: everything the organization shares with
   its workspaces, and where each works.

   Each organization machine, sandbox environment, vault, Skill and Knowledge
   entry works only where its "Available in" says. A workspace's own lists
   hold only what works there, so the page reads the organization's lists of
   machines, sandbox environments and vaults, which hold them wherever they
   work. Someone who may not read those (anyone but an organization owner or
   admin acting as themselves), or a server that can't list them all yet, gets
   the ones that work in the workspace the page is anchored on, and the page
   says so. The Skills list already holds the organization's Skills that work
   elsewhere for the people who manage them, marked as not used here.
   Knowledge has no organization-wide list: the page says whether the
   organization's Knowledge works here, and each entry's page says where it
   works.
   -------------------------------------------------------------------------- */

export type SharedOverviewClient = AvailableHereClient &
  Pick<OpenGeniBrowserClient, "listOrganizationMachines" | "listOrganizationRigs">;

/** What the page lists, in the order "Couldn't load" names them. */
export const SHARED_KINDS = ["machine", "rig", "vault", "skills", "knowledge"] as const;
export type SharedKind = (typeof SHARED_KINDS)[number];

/**
 * Where something the organization shares works: a vault's availability, or
 * a machine's or sandbox environment's reach, whose home workspace (where it
 * was connected from or made) always has it.
 */
export type SharedReach = {
  allowedWorkspaceIds: readonly string[] | null;
  allowPersonalWorkspaces: boolean;
  homeWorkspaceId?: string | undefined;
};

export type SharedVault = {
  id: string;
  name: string;
  /** "Sign-in expired"; null when all is well. */
  state: string | null;
  availability: VaultAvailability | null;
};

export type SharedCompute = {
  key: string;
  kind: "machine" | "rig";
  id: string;
  name: string;
  reach: OrganizationComputeReach;
};

/** The organization's Skills: how many, and how many don't work here. */
export type SharedSkills = { count: number; notHere: number };

/**
 * Which of the organization's things a list holds: all of them; only the
 * ones that work here because only organization owners and admins may list
 * them all; or only the ones that work here because the server can't list the
 * rest yet.
 */
export type SharedCoverage = "all" | "here-admins-see-all" | "here";

export type SharedOverviewResult = {
  /** Machines, then sandbox environments, each by name. */
  compute: SharedCompute[];
  computeCoverage: SharedCoverage;
  vaults: SharedVault[];
  vaultCoverage: SharedCoverage;
  /** Null when the organization has no Skills the viewer can see. */
  skills: SharedSkills | null;
  /** Whether the organization's Knowledge works in the anchored workspace. */
  knowledgeHere: boolean;
  /** Kinds whose list failed for a reason other than permission. */
  failed: SharedKind[];
  failureMessage: string | null;
};

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

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
): Promise<{ vaults: SharedVault[]; coverage: SharedCoverage }> {
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
      coverage: "here-admins-see-all",
    };
  }
}

function sharedCompute(
  kind: SharedCompute["kind"],
  item: { id: string; name: string; reach?: OrganizationComputeReach | null | undefined },
): SharedCompute[] {
  return item.reach
    ? [{ key: `${kind}:${item.id}`, kind, id: item.id, name: item.name, reach: item.reach }]
    : [];
}

async function organizationMachines(
  client: SharedOverviewClient,
  workspaceId: string,
): Promise<{ items: SharedCompute[]; coverage: SharedCoverage }> {
  try {
    const listed = await client.listOrganizationMachines(workspaceId);
    return {
      items: listed.machines.flatMap((machine) => sharedCompute("machine", machine)),
      coverage: listed.complete ? "all" : "here",
    };
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
    const here = await client.listMachines(workspaceId);
    return {
      items: here.machines.flatMap((machine) =>
        !machine.isSessionGroup && machine.enrollmentId && machine.scope === "organization"
          ? sharedCompute("machine", { ...machine, id: machine.enrollmentId })
          : [],
      ),
      coverage: "here-admins-see-all",
    };
  }
}

async function organizationRigs(
  client: SharedOverviewClient,
  workspaceId: string,
): Promise<{ items: SharedCompute[]; coverage: SharedCoverage }> {
  try {
    const listed = await client.listOrganizationRigs(workspaceId);
    return {
      items: listed.rigs.flatMap((rig) => sharedCompute("rig", rig)),
      coverage: listed.complete ? "all" : "here",
    };
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
    const here = await client.listRigs(workspaceId);
    return {
      items: here.flatMap((rig) =>
        rig.status === "active" && rig.scope === "organization" ? sharedCompute("rig", rig) : [],
      ),
      coverage: "here-admins-see-all",
    };
  }
}

async function organizationSkills(
  client: SharedOverviewClient,
  workspaceId: string,
): Promise<SharedSkills | null> {
  let count = 0;
  let notHere = 0;
  for (const skill of await listAllSkills(client, workspaceId)) {
    if (skill.status !== "active" || skill.scope !== "organization") continue;
    count += 1;
    if (skill.availableHere === false) notHere += 1;
  }
  return count > 0 ? { count, notHere } : null;
}

async function organizationKnowledgeHere(
  client: SharedOverviewClient,
  workspaceId: string,
): Promise<boolean> {
  return (await AVAILABLE_LOADERS.knowledge(client, workspaceId, ["organization"])).length > 0;
}

/** The narrower of two lists' coverage, for one group holding both. */
function narrower(a: SharedCoverage, b: SharedCoverage): SharedCoverage {
  if (a === "here-admins-see-all" || b === "here-admins-see-all") return "here-admins-see-all";
  if (a === "here" || b === "here") return "here";
  return "all";
}

export async function loadSharedOverview(
  client: SharedOverviewClient,
  workspaceId: string,
): Promise<SharedOverviewResult> {
  const [machines, rigs, vaults, skills, knowledge] = await Promise.allSettled([
    organizationMachines(client, workspaceId),
    organizationRigs(client, workspaceId),
    organizationVaults(client, workspaceId),
    organizationSkills(client, workspaceId),
    organizationKnowledgeHere(client, workspaceId),
  ]);
  const failed: SharedKind[] = [];
  let failureMessage: string | null = null;
  const fail = (kind: SharedKind, reason: unknown) => {
    // Someone who may not read a kind simply doesn't see it.
    if (isPermissionDenied(reason)) return;
    failed.push(kind);
    failureMessage ??= userErrorText(reason, "The service didn't answer.");
  };

  const compute: SharedCompute[] = [];
  let computeCoverage: SharedCoverage = "all";
  for (const [kind, result] of [
    ["machine", machines],
    ["rig", rigs],
  ] as const) {
    if (result.status === "fulfilled") {
      compute.push(...[...result.value.items].sort(byName));
      computeCoverage = narrower(computeCoverage, result.value.coverage);
    } else {
      fail(kind, result.reason);
    }
  }
  let sharedVaults: SharedVault[] = [];
  let vaultCoverage: SharedCoverage = "all";
  if (vaults.status === "fulfilled") {
    sharedVaults = [...vaults.value.vaults].sort(byName);
    vaultCoverage = vaults.value.coverage;
  } else {
    fail("vault", vaults.reason);
  }
  if (skills.status === "rejected") fail("skills", skills.reason);
  if (knowledge.status === "rejected") fail("knowledge", knowledge.reason);
  return {
    compute,
    computeCoverage,
    vaults: sharedVaults,
    vaultCoverage,
    skills: skills.status === "fulfilled" ? skills.value : null,
    knowledgeHere: knowledge.status === "fulfilled" && knowledge.value,
    failed,
    failureMessage,
  };
}

/* ----------------------------------------------------------------------------
   Where each works, and where its row opens.
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
 * Whether something works in a workspace, as the server decides it: always in
 * its home workspace, in a Personal workspace when the "Include personal
 * workspaces" switch is on, and in a shared one when the workspace list is
 * every shared workspace (null) or names it. No reach: everywhere.
 */
export function worksIn(
  reach: SharedReach | null,
  workspace: { id: string; personal: boolean },
): boolean {
  if (!reach) return true;
  if (reach.homeWorkspaceId === workspace.id) return true;
  if (workspace.personal) return reach.allowPersonalWorkspaces;
  return reach.allowedWorkspaceIds === null || reach.allowedWorkspaceIds.includes(workspace.id);
}

function joined(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** At most this many workspace names; the rest are counted. */
const NAMED_WORKSPACES = 3;

/** "Works in Design and Sales, and in Personal workspaces." */
export function reachSentence(
  reach: SharedReach | null,
  workspaces: readonly { id: string; name: string }[],
): string {
  if (!reach) return "Works in every workspace.";
  const personal = reach.allowPersonalWorkspaces;
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  // A home workspace without a name here is usually the Personal workspace it
  // was added from; the Personal workspaces switch already covers that one.
  const unnamedHome =
    reach.homeWorkspaceId !== undefined && !byId.has(reach.homeWorkspaceId) && !personal;
  const andHome = unnamedHome ? ", and in the workspace it was added from" : "";
  if (reach.allowedWorkspaceIds === null) {
    return personal
      ? "Works in every workspace, Personal workspaces included."
      : `Works in every shared workspace${andHome || ", not in Personal workspaces"}.`;
  }
  const ids = new Set(reach.allowedWorkspaceIds);
  if (reach.homeWorkspaceId !== undefined && byId.has(reach.homeWorkspaceId)) {
    ids.add(reach.homeWorkspaceId);
  }
  // A deleted workspace can linger in the list; it is no longer a place.
  const names = [...ids]
    .map((id) => byId.get(id))
    .filter((name): name is string => name !== undefined)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  if (names.length === 0) {
    if (unnamedHome) return "Works only in the workspace it was added from.";
    return personal ? "Works only in Personal workspaces." : "Doesn't work in any workspace yet.";
  }
  const listed =
    names.length <= NAMED_WORKSPACES + 1
      ? joined(names)
      : `${names.slice(0, NAMED_WORKSPACES).join(", ")} and ${names.length - NAMED_WORKSPACES} more`;
  if (personal) return `Works in ${listed}, and in Personal workspaces.`;
  return `Works in ${listed}${andHome}.`;
}

/** Where a row opens: a workspace it works in, or nowhere the viewer can go. */
export type SharedOpen = { workspaceId: string; workspaceName: string | null } | null;

/**
 * The anchored workspace when it works there (name null: no need to say it);
 * otherwise the first workspace by name that it works in and the viewer can
 * open, then the viewer's Personal workspace.
 */
export function sharedOpen(reach: SharedReach | null, place: SharedPlace): SharedOpen {
  if (worksIn(reach, { id: place.workspaceId, personal: place.personal })) {
    return { workspaceId: place.workspaceId, workspaceName: null };
  }
  const shared = [...place.workspaces]
    .sort(byName)
    .find(
      (workspace) =>
        place.accessibleWorkspaceIds.has(workspace.id) &&
        worksIn(reach, { id: workspace.id, personal: false }),
    );
  if (shared) return { workspaceId: shared.id, workspaceName: shared.name };
  if (
    place.personalWorkspaceId &&
    worksIn(reach, { id: place.personalWorkspaceId, personal: true })
  ) {
    return { workspaceId: place.personalWorkspaceId, workspaceName: "your Personal workspace" };
  }
  return null;
}

/** A row's sentence: where it works, then where it opens when that's elsewhere. */
export function reachDescription(reach: SharedReach | null, place: SharedPlace): string {
  const sentence = reachSentence(reach, place.workspaces);
  const open = sharedOpen(reach, place);
  if (!open) return `${sentence} You aren't in a workspace it works in.`;
  return open.workspaceName ? `${sentence} Opens in ${open.workspaceName}.` : sentence;
}

function hereName(place: SharedPlace): string {
  return place.personal ? "your Personal workspace" : place.workspaceName;
}

/** A group's description: where they work, who manages them, and what the list holds. */
export function coverageDescription(coverage: SharedCoverage, place: SharedPlace): string {
  const reach = "Each works only where its Available in says.";
  switch (coverage) {
    case "all":
      return `${reach} Organization owners and admins manage them.`;
    case "here":
      return `${reach} Organization owners and admins manage them. Here are the ones that work in ${hereName(place)}.`;
    case "here-admins-see-all":
      return `${reach} Organization owners and admins manage them and see every one; here are the ones that work in ${hereName(place)}.`;
  }
}

/** A group with nothing in it: none at all, or none that work here. */
export function emptyGroupSentence(
  coverage: SharedCoverage,
  place: SharedPlace,
  noneYet: string,
): string {
  return coverage === "all" ? noneYet : `None work in ${hereName(place)}.`;
}

/** The Skills row: how many of the organization's Skills don't work here. */
export function skillsDescription(skills: SharedSkills, place: SharedPlace): string {
  if (skills.notHere === 0) {
    return skills.count === 1
      ? `It works in ${hereName(place)}.`
      : `All of them work in ${hereName(place)}.`;
  }
  if (skills.notHere === skills.count) {
    return skills.count === 1
      ? `It doesn't work in ${hereName(place)}.`
      : `None of them work in ${hereName(place)}.`;
  }
  return `${skills.notHere} of them ${skills.notHere === 1 ? "doesn't" : "don't"} work in ${hereName(place)}.`;
}

/** The Knowledge row. */
export function knowledgeDescription(place: SharedPlace): string {
  return `The organization's Knowledge that works in ${hereName(place)}. Each entry's page says where it works.`;
}

/** "Couldn't load machines and vaults." */
export function sharedFailedSentence(failed: readonly SharedKind[]): string {
  const words: Record<SharedKind, string> = {
    machine: "machines",
    rig: "sandbox environments",
    skills: "Skills",
    knowledge: "Knowledge",
    vault: "vaults",
  };
  return `Couldn't load ${joined(failed.map((kind) => words[kind]))}.`;
}
