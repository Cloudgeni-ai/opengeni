import {
  asVaultClient,
  vaultsApi,
  type MachineState,
  type ResourceAuthorityScope,
  type VaultSummary,
} from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { isPermissionDenied, userErrorText } from "@opengeni/react/ui/api-error";

/* ----------------------------------------------------------------------------
   Available here: what agents in one workspace can use, read from the same
   lists each kind's own page reads, so the two never disagree. Every list is
   already narrowed to what reaches this workspace and what the viewer may see:
   the organization's things shared here, the workspace's own, and the
   viewer's own (never anyone else's). A list the viewer may not read is left
   out; any other failure is reported by kind.
   -------------------------------------------------------------------------- */

export type AvailableHereClient = Pick<
  OpenGeniBrowserClient,
  | "listCapabilities"
  | "listMachines"
  | "listRigs"
  | "listWorkspaceSkills"
  | "listKnowledgeEntries"
  | "requestJson"
>;

/** Who a thing belongs to, as this page groups it. */
export type AvailableOwner = "workspace" | "organization" | "you";

export type AvailableKind = "connector" | "machine" | "rig" | "vault" | "skills" | "knowledge";

/** Where a thing is managed: its own page. */
export type AvailableLocation =
  | { page: "plugins"; section?: "skills" | undefined }
  | { page: "machines" }
  | { page: "rig"; rigId: string }
  /** In the workspace the page is anchored on, or in `workspaceId` when it works only elsewhere. */
  | { page: "vault"; vaultId: string; workspaceId?: string | undefined }
  /** No scope: every scope's Knowledge (a Personal workspace's own and yours). */
  | { page: "knowledge"; scope?: "organization" | "workspace" | "personal" | undefined };

export type AvailableThing = {
  key: string;
  kind: AvailableKind;
  owner: AvailableOwner;
  name: string;
  /** Something worth knowing at a glance ("Offline"); null when all is well. */
  state: string | null;
  /** Connectors: whether each person signs in with their own account or all share one. */
  login: "own" | "shared" | null;
  /** Skills: how many. */
  count: number | null;
  open: AvailableLocation;
};

export type AvailableHereResult = {
  things: AvailableThing[];
  /** Kinds whose list failed for a reason other than permission. */
  failed: AvailableKind[];
  /** What went wrong with the first of them, in words; null when nothing failed. */
  failureMessage: string | null;
};

function ownerOfScope(scope: ResourceAuthorityScope | "personal"): AvailableOwner {
  if (scope === "organization") return "organization";
  if (scope === "workspace") return "workspace";
  return "you";
}

const MACHINE_STATES: Partial<Record<MachineState, string>> = {
  reconnecting: "Reconnecting",
  offline: "Offline",
  consent_required: "Needs approval on the machine",
  enrolling: "Setting up",
};

export function vaultState(vault: VaultSummary): string | null {
  if (vault.syncStatus === "auth_expired") return "Sign-in expired";
  if (vault.syncStatus === "error") return "Sync failed";
  return null;
}

function vaultOwner(vault: VaultSummary): AvailableOwner | null {
  switch (vault.ownerKind) {
    case "organization":
      return "organization";
    case "workspace":
      return "workspace";
    case "user":
      return "you";
    // A task's vault belongs to its scheduled task, not to the workspace.
    default:
      return null;
  }
}

async function connectors(client: AvailableHereClient, workspaceId: string) {
  const catalog = await client.listCapabilities(workspaceId);
  const items = new Map(catalog.items.map((item) => [item.id, item]));
  const things: AvailableThing[] = [];
  for (const installation of catalog.installations) {
    // Skills are counted from the Skills list, which also holds authored ones.
    if (installation.status !== "active" || installation.kind === "skill") continue;
    const item = items.get(installation.capabilityId);
    if (!item) continue;
    const scope = item.connectionRef?.subjectScope;
    things.push({
      key: `connector:${installation.id}`,
      kind: "connector",
      owner: "workspace",
      name: item.name,
      state: null,
      login: scope === "subject" ? "own" : scope === "workspace" ? "shared" : null,
      count: null,
      open: { page: "plugins" },
    });
  }
  return things;
}

async function machines(client: AvailableHereClient, workspaceId: string) {
  const listed = await client.listMachines(workspaceId);
  return listed.machines
    .filter((machine) => !machine.isSessionGroup && machine.enrollmentId)
    .map(
      (machine): AvailableThing => ({
        key: `machine:${machine.sandboxId}`,
        kind: "machine",
        owner: ownerOfScope(machine.scope),
        name: machine.name,
        state: MACHINE_STATES[machine.state] ?? null,
        login: null,
        count: null,
        open: { page: "machines" },
      }),
    );
}

async function rigs(client: AvailableHereClient, workspaceId: string) {
  const listed = await client.listRigs(workspaceId);
  return listed
    .filter((rig) => rig.status === "active")
    .map(
      (rig): AvailableThing => ({
        key: `rig:${rig.id}`,
        kind: "rig",
        owner: ownerOfScope(rig.scope),
        name: rig.name,
        state: null,
        login: null,
        count: null,
        open: { page: "rig", rigId: rig.id },
      }),
    );
}

async function vaults(client: AvailableHereClient, workspaceId: string) {
  const listed = await vaultsApi(asVaultClient(client), workspaceId).listVaults();
  const things: AvailableThing[] = [];
  for (const vault of listed) {
    const owner = vaultOwner(vault);
    if (!owner) continue;
    things.push({
      key: `vault:${vault.id}`,
      kind: "vault",
      owner,
      name: vault.name,
      state: vaultState(vault),
      login: null,
      count: null,
      open: { page: "vault", vaultId: vault.id },
    });
  }
  return things;
}

/** Pages through the Skills list; a workspace rarely has more than a few pages. */
const SKILL_PAGES = 20;

async function skills(client: AvailableHereClient, workspaceId: string) {
  const counts = new Map<AvailableOwner, number>();
  let cursor: string | undefined;
  for (let page = 0; page < SKILL_PAGES; page += 1) {
    const listed = await client.listWorkspaceSkills(workspaceId, {
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const skill of listed.skills) {
      if (skill.status !== "active") continue;
      const owner = ownerOfScope(skill.scope);
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    if (!listed.nextCursor) break;
    cursor = listed.nextCursor;
  }
  return [...counts].map(
    ([owner, count]): AvailableThing => ({
      key: `skills:${owner}`,
      kind: "skills",
      owner,
      name: "Skills",
      state: null,
      login: null,
      count,
      open: { page: "plugins", section: "skills" },
    }),
  );
}

const KNOWLEDGE_SCOPES = ["workspace", "organization", "personal"] as const;
type KnowledgeScope = (typeof KNOWLEDGE_SCOPES)[number];

async function knowledge(
  client: AvailableHereClient,
  workspaceId: string,
  scopes: readonly KnowledgeScope[] = KNOWLEDGE_SCOPES,
) {
  const found = await Promise.all(
    scopes.map(async (scope) => {
      const listed = await client.listKnowledgeEntries(workspaceId, {
        scope,
        mode: "keyword",
        limit: 1,
      });
      return listed.entries.length > 0 ? scope : null;
    }),
  );
  return found
    .filter((scope): scope is KnowledgeScope => scope !== null)
    .map(
      (scope): AvailableThing => ({
        key: `knowledge:${scope}`,
        kind: "knowledge",
        owner: ownerOfScope(scope),
        name: "Knowledge",
        state: null,
        login: null,
        count: null,
        open: { page: "knowledge", scope },
      }),
    );
}

/**
 * Each kind's loader. Organization settings › Shared reuses them for the
 * organization's own things, which reach every workspace, so one workspace's
 * lists hold them all.
 */
export const AVAILABLE_LOADERS: Readonly<
  Record<
    AvailableKind,
    (client: AvailableHereClient, workspaceId: string) => Promise<AvailableThing[]>
  >
> & {
  knowledge: (
    client: AvailableHereClient,
    workspaceId: string,
    scopes?: readonly KnowledgeScope[],
  ) => Promise<AvailableThing[]>;
} = {
  connector: connectors,
  machine: machines,
  rig: rigs,
  vault: vaults,
  skills,
  knowledge,
};

export const AVAILABLE_KINDS: readonly AvailableKind[] = [
  "connector",
  "machine",
  "rig",
  "vault",
  "skills",
  "knowledge",
];

export async function loadAvailableHere(
  client: AvailableHereClient,
  workspaceId: string,
): Promise<AvailableHereResult> {
  const settled = await Promise.allSettled(
    AVAILABLE_KINDS.map((kind) => AVAILABLE_LOADERS[kind](client, workspaceId)),
  );
  const things: AvailableThing[] = [];
  const failed: AvailableKind[] = [];
  let failureMessage: string | null = null;
  settled.forEach((result, index) => {
    const kind = AVAILABLE_KINDS[index]!;
    if (result.status === "fulfilled") things.push(...result.value);
    // Someone who may not read a kind here simply doesn't see it.
    else if (!isPermissionDenied(result.reason)) {
      failed.push(kind);
      failureMessage ??= userErrorText(result.reason, "The service didn't answer.");
    }
  });
  return { things, failed, failureMessage };
}

/* ----------------------------------------------------------------------------
   Grouping and words.
   -------------------------------------------------------------------------- */

export type AvailableGroup = {
  owner: AvailableOwner;
  title: string;
  description: string;
  things: AvailableThing[];
};

export type AvailableNames = {
  workspace: string;
  organization: string;
  /** The viewer's Personal workspace: everything here is theirs alone. */
  personal: boolean;
};

const KIND_ORDER = new Map(AVAILABLE_KINDS.map((kind, index) => [kind, index]));

export const KIND_LABELS: Readonly<Record<AvailableKind, string>> = {
  connector: "Connector",
  machine: "Machine",
  rig: "Rig",
  vault: "Vault",
  skills: "Skills",
  knowledge: "Knowledge",
};

/** The right-hand value of a row: the kind, and its state when there is one. */
export function availableValue(thing: AvailableThing): string {
  if (thing.kind === "skills") return String(thing.count ?? 0);
  if (thing.kind === "knowledge") return "";
  return thing.state ? `${KIND_LABELS[thing.kind]} · ${thing.state}` : KIND_LABELS[thing.kind];
}

/**
 * The row's sentence. Organization things and your own say who manages them
 * once, in their group; a workspace's own things differ by kind, because
 * workspace members can change rigs, vaults, Skills and Knowledge but only
 * admins manage connectors and machines.
 */
export function availableDescription(thing: AvailableThing, names: AvailableNames): string {
  const parts: string[] = [];
  if (!names.personal && thing.login === "own")
    parts.push("Each person signs in with their own account.");
  if (!names.personal && thing.login === "shared")
    parts.push("Everyone's messages here use the same login.");
  if (thing.owner === "workspace" && !names.personal) {
    const it = thing.kind === "skills" ? "them" : "it";
    parts.push(
      thing.kind === "connector" || thing.kind === "machine"
        ? `Admins of ${names.workspace} manage ${it}.`
        : `Members and admins of ${names.workspace} can change ${it}.`,
    );
  }
  return parts.join(" ");
}

export function sortThings(things: AvailableThing[]): AvailableThing[] {
  return [...things].sort(
    (a, b) =>
      (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/**
 * In a Personal workspace the workspace's own things and your own are the same
 * thing, yours alone, so they share one group, and one Skills and one
 * Knowledge row.
 */
function mergeYours(things: AvailableThing[]): AvailableThing[] {
  const merged: AvailableThing[] = [];
  const rows = new Map<AvailableKind, AvailableThing>();
  for (const thing of things) {
    const owned = thing.owner === "workspace" ? { ...thing, owner: "you" as const } : thing;
    const countable = owned.kind === "skills" || owned.kind === "knowledge";
    const earlier = owned.owner === "you" && countable ? rows.get(owned.kind) : undefined;
    if (!earlier) {
      const row = {
        ...owned,
        key: countable && owned.owner === "you" ? `${owned.kind}:you` : owned.key,
      };
      if (countable && owned.owner === "you") rows.set(owned.kind, row);
      merged.push(row);
      continue;
    }
    if (owned.kind === "skills") earlier.count = (earlier.count ?? 0) + (owned.count ?? 0);
    else earlier.open = { page: "knowledge" };
  }
  return merged;
}

export function availableGroups(
  things: readonly AvailableThing[],
  names: AvailableNames,
): AvailableGroup[] {
  const all = names.personal ? mergeYours([...things]) : [...things];
  const of = (owner: AvailableOwner) => sortThings(all.filter((thing) => thing.owner === owner));
  const groups: AvailableGroup[] = names.personal
    ? [
        {
          owner: "you",
          title: "Yours",
          description: "Only you and your own messages use these, and only you manage them.",
          things: of("you"),
        },
        {
          owner: "organization",
          title: `Shared by ${names.organization}`,
          description: `${names.organization} shares these with your Personal workspace. Organization owners manage them.`,
          things: of("organization"),
        },
      ]
    : [
        {
          owner: "workspace",
          title: `Belongs to ${names.workspace}`,
          description: `Any message in ${names.workspace} can use these.`,
          things: of("workspace"),
        },
        {
          owner: "organization",
          title: `Shared by ${names.organization}`,
          description: `${names.organization} shares these with ${names.workspace}. Any message here can use them. Organization owners manage them.`,
          things: of("organization"),
        },
        {
          owner: "you",
          title: "Yours",
          description:
            "Only your own messages here use these, never anyone else's. Only you manage them.",
          things: of("you"),
        },
      ];
  return groups.filter((group) => group.things.length > 0);
}

/** "Couldn't load machines and vaults." */
export function failedSentence(failed: readonly AvailableKind[]): string {
  const words: Record<AvailableKind, string> = {
    connector: "connectors",
    machine: "machines",
    rig: "rigs",
    vault: "vaults",
    skills: "Skills",
    knowledge: "Knowledge",
  };
  const listed = failed.map((kind) => words[kind]);
  const joined =
    listed.length <= 1
      ? (listed[0] ?? "")
      : `${listed.slice(0, -1).join(", ")} and ${listed.at(-1)}`;
  return `Couldn't load ${joined}.`;
}
