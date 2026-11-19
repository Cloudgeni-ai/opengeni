/**
 * Runs on for an organization (Console) agent chat: where the chat's
 * computer is. Called by `prepareOrgAgentSessionCreate` after the version's
 * settings became an ordinary create body; a create that names no
 * organization agent never runs this.
 *
 * The version's `runsOn` becomes the same create fields a request can pass
 * today (`sandboxBackend`, `targetSandboxId`, `rigId`), and the request is
 * layered on top: code has the final say for one chat. Nothing here bypasses
 * the create path's own checks (served backends, machine access through
 * `get_scoped_sandbox` / `authorize_scoped_sandbox_attach`, rig reach through
 * `list_scoped_rigs`); it adds two refusals of its own:
 *
 * - a Personal (Only me) machine never runs an organization agent chat, also
 *   when the request names it (`personal_machine_not_allowed`); the create
 *   path checks the machine again once placement is final
 *   ({@link assertOrgAgentChatMachine}), so defaults and a worker joining its
 *   parent's box are covered too;
 * - the version's machine or sandbox environment must work in this workspace
 *   (`runs_on_unavailable`, with what to change), checked with the same
 *   reach-aware lists the app uses.
 *
 * A version saved with a machine or environment keeps its id
 * (`agent_revisions.runs_on_target`); chats use that id, and the written name
 * only when the saved one was removed.
 *
 * Omitted `runsOn` keeps today's placement. A chat started from inside
 * another chat (a worker) keeps sharing its parent's computer unless the
 * request asks for its own (`sandbox: "new"`).
 */
import type { Settings } from "@opengeni/config";
import type { AccessGrant, OrgAgentRunsOn, OrgAgentSessionOverrides } from "@opengeni/contracts";
import {
  findOrgCompute,
  getRig,
  getSandbox,
  listEnrollments,
  listOrganizationComputeInAccount,
  withAccountRls,
  type Database,
  type OrgAgentRunsOnTarget,
  type OrgComputeEntry,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

/** A refused create: `code` is one of `ORG_AGENT_ERROR_CODES`. */
export class OrgAgentRunsOnError extends HTTPException {
  constructor(
    readonly httpStatus: 422,
    readonly code:
      | "machine_not_found"
      | "environment_not_found"
      | "personal_machine_not_allowed"
      | "runs_on_unavailable",
    message: string,
  ) {
    super(httpStatus, { message });
    this.name = "OrgAgentRunsOnError";
  }
}

/** The create fields that decide where a chat runs. */
export const ORG_AGENT_PLACEMENT_FIELDS = [
  "sandboxBackend",
  "targetSandboxId",
  "rigId",
  "sandbox",
] as const;
type PlacementField = (typeof ORG_AGENT_PLACEMENT_FIELDS)[number];
type Placement = Partial<Record<PlacementField, unknown>>;

export type OrgAgentRunsOnDeps = {
  db: Database;
  settings: Pick<Settings, "sandboxBackend">;
  /** Test seams; default to the database reads. */
  listOrganizationCompute?: (kind: "machine" | "rig") => Promise<OrgComputeEntry[]>;
  machineWorksHere?: (enrollmentId: string) => Promise<boolean>;
  rigWorksHere?: (rigId: string) => Promise<boolean>;
  sandboxScope?: (sandboxId: string) => Promise<string | null>;
};

function requested(raw: Record<string, unknown>): Placement {
  const placement: Placement = {};
  for (const field of ORG_AGENT_PLACEMENT_FIELDS) {
    if (Object.hasOwn(raw, field) && raw[field] !== undefined) placement[field] = raw[field];
  }
  return placement;
}

function samePlacementValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

const PERSONAL_MACHINE_MESSAGE =
  "A Personal (Only me) machine can't run a chat with an organization agent. Choose an organization machine.";

/**
 * The final check on where an organization agent chat (named on create, or
 * inherited by a worker) lands, once placement is settled: the request's
 * machine, a default, or the parent's box a worker joins. A Personal (Only me)
 * machine is refused, and so is a target this caller can't read, because the
 * create path reads it with the same caller and could not attach it either.
 * Anything else passes: organization and workspace machines, and boxes that
 * are not Connected Machines (a cloud sandbox has no machine scope).
 */
export async function assertOrgAgentChatMachine(
  deps: {
    db: Database;
    /** Test seam: the target as `get_scoped_sandbox` reads it, or null when unreadable. */
    readSandbox?: (sandboxId: string) => Promise<{ scope: string | null } | null>;
  },
  access: { accountId: string; workspaceId: string; subjectId: string },
  sandboxId: string,
): Promise<void> {
  const sandbox = deps.readSandbox
    ? await deps.readSandbox(sandboxId)
    : await getSandbox(deps.db, access, sandboxId);
  if (!sandbox) {
    throw new OrgAgentRunsOnError(
      422,
      "runs_on_unavailable",
      "The machine this chat would run on isn't available in this workspace.",
    );
  }
  if (sandbox.scope === "user") {
    throw new OrgAgentRunsOnError(422, "personal_machine_not_allowed", PERSONAL_MACHINE_MESSAGE);
  }
}

/**
 * Whether a reach-aware list shows it here. A list this caller cannot read
 * (for example a person without access to the workspace) answers true: the
 * create path's own machine and rig checks then decide, as for any chat.
 */
async function worksHere(read: () => Promise<boolean>): Promise<boolean> {
  try {
    return await read();
  } catch {
    return true;
  }
}

/**
 * The create body with the agent's placement and the request's on top, and
 * the `runsOn` override when the request changed where the chat runs.
 */
export async function applyOrgAgentRunsOn(input: {
  deps: OrgAgentRunsOnDeps;
  grant: Pick<AccessGrant, "accountId" | "subjectId" | "metadata">;
  workspaceId: string;
  /** The create body after the agent's other settings were applied. */
  payload: Record<string, unknown>;
  runsOn: OrgAgentRunsOn | undefined;
  /**
   * The ids `runsOn` resolved to when the version was saved; chats use these,
   * and the written name only for versions saved without them.
   */
  target?: OrgAgentRunsOnTarget | null;
}): Promise<{ payload: Record<string, unknown>; overrides: OrgAgentSessionOverrides }> {
  const { deps, grant, workspaceId, runsOn } = input;
  const target = input.target ?? null;
  const subjectId = grant.subjectId ?? "";
  const access = { accountId: grant.accountId, workspaceId, subjectId };
  const request = requested(input.payload);

  // A Personal machine never runs an organization agent chat.
  if (typeof request.targetSandboxId === "string") {
    const scope = deps.sandboxScope
      ? await deps.sandboxScope(request.targetSandboxId)
      : ((await getSandbox(deps.db, access, request.targetSandboxId))?.scope ?? null);
    if (scope === "user") {
      throw new OrgAgentRunsOnError(422, "personal_machine_not_allowed", PERSONAL_MACHINE_MESSAGE);
    }
  }
  if (!runsOn) return { payload: input.payload, overrides: {} };

  // A worker shares its parent's computer unless it asks for its own.
  const inSession = typeof grant.metadata?.["sessionId"] === "string";
  const joinsExisting =
    (request.sandbox !== undefined && request.sandbox !== "new") ||
    (inSession && request.sandbox === undefined && request.targetSandboxId === undefined);

  // What the request leaves to the agent.
  const requestTarget = request.targetSandboxId !== undefined;
  const requestBackend = request.sandboxBackend !== undefined;
  const takeBackendAndTarget = !joinsExisting && !requestTarget && !requestBackend;
  const takeRig =
    !joinsExisting &&
    !requestTarget &&
    request.rigId === undefined &&
    (!requestBackend || (runsOn.kind === "sandbox" && request.sandboxBackend !== "none"));

  const agent = await agentPlacement(deps, access, runsOn, target, {
    resolveMachine: takeBackendAndTarget,
    resolveRig: takeRig,
    requireCloudSandbox: takeBackendAndTarget,
  });

  const payload: Record<string, unknown> = { ...input.payload };
  if (takeBackendAndTarget) {
    if (agent.sandboxBackend !== undefined) payload["sandboxBackend"] = agent.sandboxBackend;
    if (agent.targetSandboxId !== undefined) payload["targetSandboxId"] = agent.targetSandboxId;
  }
  if (takeRig && agent.rigId !== undefined) payload["rigId"] = agent.rigId;

  const overrides: OrgAgentSessionOverrides = {};
  const changed = Object.entries(request).some(([field, value]) => {
    if (field === "sandbox") return joinsExisting;
    return !samePlacementValue(value, agent[field as PlacementField]);
  });
  if (changed || (joinsExisting && Object.keys(request).length > 0)) {
    overrides["runsOn"] = { agent: runsOn, chat: request };
  }
  return { payload, overrides };
}

/**
 * The create fields for the version's `runsOn`. A machine or environment is
 * looked up only when the request leaves it to the agent, so a chat that
 * picks its own computer is not refused for the agent's.
 */
async function agentPlacement(
  deps: OrgAgentRunsOnDeps,
  access: { accountId: string; workspaceId: string; subjectId: string },
  runsOn: OrgAgentRunsOn,
  target: OrgAgentRunsOnTarget | null,
  wanted: { resolveMachine: boolean; resolveRig: boolean; requireCloudSandbox: boolean },
): Promise<Placement> {
  switch (runsOn.kind) {
    case "none":
      // No computer, and no sandbox environment to build one from.
      return { sandboxBackend: "none", rigId: null };
    case "sandbox": {
      const backend = deps.settings.sandboxBackend;
      if (wanted.requireCloudSandbox && (backend === "selfhosted" || backend === "none")) {
        throw new OrgAgentRunsOnError(
          422,
          "runs_on_unavailable",
          "This agent runs in a cloud sandbox, which this deployment does not provide.",
        );
      }
      const placement: Placement = { sandboxBackend: backend };
      if (runsOn.environment !== undefined && wanted.resolveRig) {
        const rig = await resolveCompute(
          deps,
          access.accountId,
          "rig",
          runsOn.environment,
          target?.environmentId,
        );
        const works = await worksHere(async () =>
          deps.rigWorksHere
            ? await deps.rigWorksHere(rig.id)
            : (await getRig(deps.db, access, rig.id)) !== null,
        );
        if (!works) {
          throw new OrgAgentRunsOnError(
            422,
            "runs_on_unavailable",
            `The sandbox environment '${rig.name}' isn't available in this workspace. Add this workspace, or All product-managed workspaces, where it can be used.`,
          );
        }
        placement.rigId = rig.id;
      }
      return placement;
    }
    case "machine": {
      // A machine brings its own environment.
      const placement: Placement = { rigId: null };
      if (runsOn.machine === undefined) return placement;
      if (!wanted.resolveMachine) {
        // The request picked the computer; the agent's machine only tells
        // whether that is a change.
        const machine = await resolveCompute(
          deps,
          access.accountId,
          "machine",
          runsOn.machine,
          target?.machineId,
        ).catch(() => null);
        if (machine?.sandboxId) placement.targetSandboxId = machine.sandboxId;
        return placement;
      }
      const machine = await resolveCompute(
        deps,
        access.accountId,
        "machine",
        runsOn.machine,
        target?.machineId,
      );
      const works = await worksHere(async () =>
        deps.machineWorksHere
          ? await deps.machineWorksHere(machine.id)
          : (await listEnrollments(deps.db, access)).some((entry) => entry.id === machine.id),
      );
      if (!works || !machine.sandboxId) {
        throw new OrgAgentRunsOnError(
          422,
          "runs_on_unavailable",
          machine.sandboxId
            ? `The organization machine '${machine.name}' isn't available in this workspace. Add this workspace, or All product-managed workspaces, where it can be used.`
            : `The organization machine '${machine.name}' isn't ready to run chats yet.`,
        );
      }
      placement.targetSandboxId = machine.sandboxId;
      return placement;
    }
  }
}

/**
 * The machine or environment the version names: by the id saved with the
 * version (`pinnedId`), so a rename or a second one with the same name changes
 * nothing; by the written `ref` for a version saved without an id or when the
 * saved one was removed.
 */
async function resolveCompute(
  deps: OrgAgentRunsOnDeps,
  accountId: string,
  kind: "machine" | "rig",
  ref: string,
  pinnedId?: string | undefined,
): Promise<OrgComputeEntry> {
  const entries = deps.listOrganizationCompute
    ? await deps.listOrganizationCompute(kind)
    : await withAccountRls(deps.db, accountId, (tx) =>
        listOrganizationComputeInAccount(tx, accountId, kind),
      );
  const what = kind === "machine" ? "organization machine" : "organization sandbox environment";
  if (pinnedId) {
    const pinned = entries.find((entry) => entry.id === pinnedId);
    if (pinned) return pinned;
    // The saved one was removed: a replacement under the written name (for
    // example the same machine connected again) keeps the agent working, and
    // a redeploy of the same file, which reuses this version, needs no edit.
  }
  const match = findOrgCompute(entries, ref);
  if (match.status === "found") return match.entry;
  throw new OrgAgentRunsOnError(
    422,
    kind === "machine" ? "machine_not_found" : "environment_not_found",
    match.status === "ambiguous"
      ? `${match.count} ${what}s are named '${ref}'. Name it by its id in the agent's Runs on.`
      : `This agent runs on '${ref}', which is not an ${what} of this organization.`,
  );
}
