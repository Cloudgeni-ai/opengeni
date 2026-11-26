import type {
  AccessGrant,
  AppPackageProblem,
  AppPackageSkill,
  SkillActor,
  SkillFile,
  SkillRecord,
} from "@opengeni/contracts";
import { listSkills, readSkill, saveSkill, type ApiRouteDeps } from "@opengeni/core";
import {
  appPackageSkillIds,
  relinkAppPackageSkill,
  type AppPackageInstall,
  type AppPackageInstallSkill,
} from "@opengeni/db";
import { createHash } from "node:crypto";
import { reason } from "./service";

/**
 * The Skills an app package carries (docs/app-packages.md#skills). They are
 * ordinary workspace Skills, saved through the Skill registry like any other
 * (the same lifecycle, Agent learning for agents, revision history), named
 * by their SKILL.md and linked to the app with the revision the package
 * wrote. A Skill with the package's name that another copy of the same
 * package added is shared, not added twice (an install links it as it is;
 * only an upgrade, after its plan, replaces it); one that has nothing to do
 * with the package is left as it is and reported.
 */

/** Who writes the Skills, or why they can't be written (reported per Skill). */
export type PackageSkillWriter = { actor: SkillActor } | { refused: string };

export type PackageSkillPlan = {
  added: string[];
  changed: string[];
  unchanged: string[];
  /** Skills that came with the app that the package no longer has: they stay. */
  kept: string[];
  problems: AppPackageProblem[];
  /** Per package Skill, what applying does. */
  steps: Array<{
    skill: AppPackageSkill;
    /** The workspace Skill it updates or links, or null to add a new one. */
    current: SkillRecord | null;
    write: boolean;
  }>;
};

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function filesKey(files: readonly SkillFile[]): string {
  return JSON.stringify(
    [...files]
      .map(({ path, content }) => [path, content])
      .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)),
  );
}

/** A deterministic UUID for one Skill write of one install or upgrade, so a retry replays it. */
function operationUuid(operationKey: string, part: string): string {
  const hex = createHash("sha256").update(`${operationKey}\u0000${part}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${(
    (Number.parseInt(hex[16]!, 16) & 0x3) |
    0x8
  ).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function workspaceSkillNamed(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  name: string,
): Promise<SkillRecord | null> {
  const [found] = await listSkills(
    deps.db,
    { accountId: grant.accountId, workspaceId: grant.workspaceId },
    { scope: "workspace", after: { stableKey: name, id: ZERO_UUID }, limit: 1 },
  );
  return found && found.stableKey === name ? found : null;
}

/**
 * Whether a linked Skill was edited here: its live revision is neither the
 * one the package wrote nor one it saved for review.
 */
export function skillModified(
  record: Pick<SkillRecord, "activeRevisionId"> | null,
  link: AppPackageInstallSkill,
): boolean {
  const live = record?.activeRevisionId;
  if (!live || (!link.revisionId && !link.pendingRevisionId)) return false;
  return live !== link.revisionId && live !== link.pendingRevisionId;
}

export const APP_CUSTOMIZED_MESSAGE =
  "This app was customized here, so it no longer gets package updates. Customized apps keep their changes; add the new version as a separate app instead.";

/**
 * Whether an installed app was customized here: its app version is no longer
 * the one the package installed (or last upgraded to), or one of its linked
 * Skills was edited. A customized app is forked and gets no package updates.
 */
export async function appPackageCustomized(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  install: Pick<AppPackageInstall, "versionId" | "skills"> | null,
  currentVersionId: string,
): Promise<boolean> {
  if (!install) return false;
  if (install.versionId && install.versionId !== currentVersionId) return true;
  const context = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  for (const link of install.skills) {
    const record = await readSkill(deps.db, context, link.skillId).catch(() => null);
    if (skillModified(record, link)) return true;
  }
  return false;
}

export async function planPackageSkills(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  input: {
    skills: readonly AppPackageSkill[];
    links: readonly AppPackageInstallSkill[];
    packageId: string | null;
    /** An install links a shared Skill as it is; an upgrade replaces it. */
    mode: "install" | "upgrade";
  },
): Promise<PackageSkillPlan> {
  const plan: PackageSkillPlan = {
    added: [],
    changed: [],
    unchanged: [],
    kept: [],
    problems: [],
    steps: [],
  };
  const context = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  let shared: Set<string> | null = null;
  for (const skill of input.skills) {
    const link = input.links.find((entry) => entry.name === skill.name);
    let current = link ? await readSkill(deps.db, context, link.skillId) : null;
    if (!current) {
      // Not linked (or its Skill was removed): one with its name may exist.
      const named = await workspaceSkillNamed(deps, grant, skill.name);
      if (named) {
        shared ??= input.packageId
          ? await appPackageSkillIds(deps.db, grant.workspaceId, input.packageId)
          : new Set<string>();
        if (!shared.has(named.id) && filesKey(named.files) !== filesKey(skill.files)) {
          plan.problems.push({
            part: "skill",
            name: skill.name,
            reason:
              "A different Skill with this name is already in this workspace; it stays as it is and the app doesn't use the package's",
          });
          continue;
        }
        if (input.mode === "install" && filesKey(named.files) !== filesKey(skill.files)) {
          // Another copy of the app shares it, maybe edited or newer: link it
          // as it is; an upgrade's plan shows replacing it.
          plan.unchanged.push(skill.name);
          plan.steps.push({ skill, current: named, write: false });
          continue;
        }
        current = named;
      }
    }
    if (!current) {
      plan.added.push(skill.name);
      plan.steps.push({ skill, current: null, write: true });
    } else if (filesKey(current.files) === filesKey(skill.files)) {
      (link ? plan.unchanged : plan.added).push(skill.name);
      plan.steps.push({ skill, current, write: false });
    } else {
      plan.changed.push(skill.name);
      plan.steps.push({ skill, current, write: true });
    }
  }
  const packaged = new Set(input.skills.map((skill) => skill.name));
  for (const link of input.links) if (!packaged.has(link.name)) plan.kept.push(link.name);
  return plan;
}

/**
 * Write the planned Skills and return the app's links. Each write replays
 * under `operationKey`, so a retried install or upgrade writes once. A
 * refused or failed write is reported and the Skill keeps its old link.
 */
export async function applyPackageSkills(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  input: {
    plan: PackageSkillPlan;
    links: readonly AppPackageInstallSkill[];
    writer: PackageSkillWriter;
    operationKey: string;
    appTitle: string;
  },
  problems: AppPackageProblem[],
): Promise<{ links: AppPackageInstallSkill[]; written: string[] }> {
  const links = new Map(input.links.map((link) => [link.name, link]));
  const written: string[] = [];
  for (const step of input.plan.steps) {
    const { skill, current } = step;
    if (!step.write) {
      if (current)
        links.set(skill.name, {
          skillId: current.id,
          name: skill.name,
          revisionId: current.activeRevisionId ?? current.revisionId,
          ...(links.get(skill.name)?.pendingRevisionId
            ? { pendingRevisionId: links.get(skill.name)!.pendingRevisionId }
            : {}),
        });
      continue;
    }
    if ("refused" in input.writer) {
      problems.push({ part: "skill", name: skill.name, reason: input.writer.refused });
      continue;
    }
    try {
      const receipt = await saveSkill(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        actor: input.writer.actor,
        operationId: operationUuid(input.operationKey, `skill:${skill.name}`),
        skillId: current?.id ?? operationUuid(input.operationKey, `skill-id:${skill.name}`),
        expectedRevisionId: current ? (current.activeRevisionId ?? current.revisionId) : null,
        // A new Skill's head starts at scope version 1.
        expectedScopeVersion: current?.scopeVersion ?? 1,
        scope: "workspace",
        stableKey: current?.stableKey ?? skill.name,
        files: skill.files,
        reason: `${current ? "Updated" : "Added"} with the app ${input.appTitle}`.slice(0, 2000),
      });
      if (receipt.outcome === "pending") {
        // Not live until approved: the live revision stays the linked one.
        links.set(skill.name, {
          skillId: receipt.skillId,
          name: skill.name,
          revisionId: current ? (current.activeRevisionId ?? current.revisionId) : null,
          pendingRevisionId: receipt.revisionId,
        });
      } else {
        links.set(skill.name, {
          skillId: receipt.skillId,
          name: skill.name,
          revisionId: receipt.revisionId,
        });
        // Other copies of the package that share it now link the new revision.
        if (current)
          await relinkAppPackageSkill(deps.db, grant.workspaceId, {
            skillId: receipt.skillId,
            revisionId: receipt.revisionId,
          }).catch(() => undefined);
      }
      written.push(skill.name);
      if (receipt.outcome === "pending")
        problems.push({
          part: "skill",
          name: skill.name,
          reason: "Saved for review: it works once someone approves it on the Skills page",
        });
    } catch (error) {
      problems.push({ part: "skill", name: skill.name, reason: reason(error, "saving a Skill") });
    }
  }
  return { links: [...links.values()], written };
}
