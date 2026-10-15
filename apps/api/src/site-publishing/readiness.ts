import type {
  AccessGrant,
  SitePublishWarningFix,
  SiteAccessMode,
  SiteDataAccessMode,
  SiteDataGuestAccess,
  SitePublishWarning,
  SiteSqlQueryAudience,
} from "@opengeni/contracts";
import {
  getPublishedSite,
  getPublishedSiteVersion,
  listSiteSqlQueries,
  type SitePublicationRecord,
  type SitePublishingScope,
} from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";
import { defineSiteDataCollection } from "../site-data/operations";
import { siteDataStore } from "../site-data/service";
import { defineSiteSqlQuery } from "../site-sql/service";
import { resolveSiteOutsideModel, type SiteOutsideModelChoice } from "./agent-model";
import { effectiveSiteAccess, siteGuestsAllowed } from "./viewer";

/**
 * Publish readiness: what the published version uses that its audience may
 * not do. A conservative static reading of the page (the stored HTML) plus
 * the Site's declared tools, collections and named queries; it never blocks
 * publishing. The heuristics (docs/published-sites.md, "Readiness check"):
 *
 * - a collection is used when the page names it in `collection("name")`; it
 *   is written when that expression, or a variable assigned from it, calls
 *   insert, put, patch, delete or increment;
 * - a named query is used when the page calls `sql.run("name")`;
 * - workspace tools are used when the version requests tools, or the page
 *   calls `tools.<server>.<tool>` or `tools.$call`.
 *
 * Names built at run time are not seen, so a clean result is not a proof.
 */

const NAME = "[A-Za-z][A-Za-z0-9_-]{0,63}";
const WRITE_METHODS = "insert|put|patch|delete|increment";
/** Writes beyond adding a record (only `own` guest access allows them). */
const CHANGE_METHODS = new Set(["put", "patch", "delete", "increment"]);
/** The most HTML read for the check. */
export const SITE_READINESS_MAX_HTML_BYTES = 2 * 1024 * 1024;

export type SitePageUsage = {
  /** Collections the page names, and how it writes them. */
  collections: Map<string, { writes: boolean; changes: boolean }>;
  queries: Set<string>;
  workspaceTools: boolean;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** What a page's source uses (see the heuristics above). */
export function scanSitePageUsage(source: string): SitePageUsage {
  const collections = new Map<string, { writes: boolean; changes: boolean }>();
  const note = (name: string, method: string | undefined) => {
    const entry = collections.get(name) ?? { writes: false, changes: false };
    if (method) {
      entry.writes = true;
      if (CHANGE_METHODS.has(method)) entry.changes = true;
    }
    collections.set(name, entry);
  };
  const direct = new RegExp(
    `collection\\(\\s*(["'\`])(${NAME})\\1\\s*\\)(?:\\s*\\.\\s*(${WRITE_METHODS})\\b)?`,
    "gu",
  );
  for (const match of source.matchAll(direct)) note(match[2]!, match[3]);
  const assigned = new RegExp(
    `\\b([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?[\\w$.]*collection\\(\\s*(["'\`])(${NAME})\\2\\s*\\)\\s*[;,\\n)]`,
    "gu",
  );
  for (const match of source.matchAll(assigned)) {
    const variable = match[1]!;
    const name = match[3]!;
    const calls = new RegExp(
      `(?<![\\w$.])${escapeRegExp(variable)}\\s*\\.\\s*(${WRITE_METHODS})\\s*\\(`,
      "gu",
    );
    for (const call of source.matchAll(calls)) note(name, call[1]);
  }
  const queries = new Set<string>();
  for (const match of source.matchAll(
    new RegExp(`sql\\s*\\.\\s*run\\(\\s*(["'\`])(${NAME})\\1`, "gu"),
  ))
    queries.add(match[2]!);
  const workspaceTools =
    /\btools\s*\.\s*\$call\s*\(/u.test(source) ||
    /\btools\s*\.\s*(?!\$)[A-Za-z_][\w$]*\s*\.\s*[A-Za-z_][\w$]*\s*\(/u.test(source);
  return { collections, queries, workspaceTools };
}

export type SiteReadinessInput = {
  access: SiteAccessMode;
  /** Anonymous visitors are admitted (public, and not a login-only deployment). */
  guestsAllowed: boolean;
  page: SitePageUsage | null;
  requestedTools: number;
  agent: { enabled: boolean; tools: readonly string[] | null };
  collections: ReadonlyArray<{
    name: string;
    accessMode: SiteDataAccessMode;
    guestAccess: SiteDataGuestAccess;
  }>;
  queries: ReadonlyArray<{ name: string; audience: SiteSqlQueryAudience }>;
  outsideModel: SiteOutsideModelChoice | null;
};

function audienceLabel(input: Pick<SiteReadinessInput, "access" | "guestsAllowed">): string {
  if (input.access === "invited") return "invited people";
  return input.guestsAllowed ? "public visitors" : "people outside the workspace";
}

/** The warnings for a members-only Site are none: members may do everything the page does. */
export function siteReadinessWarnings(input: SiteReadinessInput): SitePublishWarning[] {
  if (input.access === "members") return [];
  const who = audienceLabel(input);
  const Who = who.charAt(0).toUpperCase() + who.slice(1);
  const warnings: SitePublishWarning[] = [];
  const add = (warning: Omit<SitePublishWarning, "fix"> & { fix?: SitePublishWarning["fix"] }) =>
    warnings.push({ fix: null, ...warning });
  if (input.requestedTools > 0 || input.page?.workspaceTools)
    add({
      code: "workspace_tools_members_only",
      message: `The page uses workspace tools, which ${who} can't use.`,
      suggestion:
        "Build the page on Site Data and Site SQL instead, or publish to members only.",
    });
  if (input.agent.enabled && (input.agent.tools?.length ?? 0) > 0)
    add({
      code: "agent_tools_members_only",
      message: `The assistant's workspace tools are for workspace members only; ${who} get none.`,
      suggestion: "Let the assistant answer from the page and the Site's own data for them.",
    });
  const byName = new Map(input.collections.map((collection) => [collection.name, collection]));
  for (const [name, use] of input.page?.collections ?? []) {
    const collection = byName.get(name);
    if (!collection) continue;
    if (use.writes && collection.accessMode === "shared_read")
      add({
        code: "site_data_members_write",
        message: `${Who} can read ${name} but can't save to it: only the Site's managers write it.`,
        suggestion: `Change ${name} to shared, per_viewer or append_only, or publish to members only.`,
      });
    if (!input.guestsAllowed) continue;
    const guestAccess = collection.guestAccess;
    if (use.writes && guestAccess !== "append" && guestAccess !== "own") {
      const needed = use.changes ? "own" : "append";
      add({
        code: "site_data_guest_write",
        message: `${name} can't be saved by anonymous public visitors.`,
        suggestion: `Allow guests to ${needed === "own" ? "add and change their own" : "add"} ${name}, or publish to invited people only.`,
        fix: { kind: "site_data_guest_access", collection: name, guestAccess: needed },
      });
    } else if (use.changes && guestAccess === "append")
      add({
        code: "site_data_guest_write",
        message: `Anonymous public visitors can add to ${name} but can't change or delete what they added.`,
        suggestion: `Allow guests to change their own ${name}, or publish to invited people only.`,
        fix: { kind: "site_data_guest_access", collection: name, guestAccess: "own" },
      });
    else if (!use.writes && guestAccess === "none")
      add({
        code: "site_data_guest_read",
        message: `${name} can't be read by anonymous public visitors.`,
        suggestion: `Allow guests to read ${name}, or publish to invited people only.`,
        fix: { kind: "site_data_guest_access", collection: name, guestAccess: "read" },
      });
  }
  const queries = new Map(input.queries.map((query) => [query.name, query]));
  for (const name of input.page?.queries ?? []) {
    const query = queries.get(name);
    if (!query) continue;
    const audience = input.guestsAllowed ? "everyone" : "signed_in";
    if (query.audience === "managers")
      add({
        code: "site_sql_query_managers",
        message: `The query ${name} is for the Site's managers only, so the page can't run it for ${who}.`,
        suggestion: `Let ${input.guestsAllowed ? "everyone" : "signed-in viewers"} run ${name}, or publish to members only.`,
        fix: { kind: "site_sql_query_audience", query: name, audience },
      });
    else if (query.audience === "signed_in" && input.guestsAllowed)
      add({
        code: "site_sql_query_signed_in",
        message: `The query ${name} needs a signed-in viewer, so anonymous public visitors can't run it.`,
        suggestion: `Let everyone run ${name}, or publish to invited people only.`,
        fix: { kind: "site_sql_query_audience", query: name, audience: "everyone" },
      });
  }
  if (input.agent.enabled && input.outsideModel?.kind === "fallback")
    add({
      code: "agent_model_outside_fallback",
      message: `People outside the workspace use ${input.outsideModel.model} (paid with credits).`,
      suggestion: "Pick a credit-billed model if they should use the same one as members.",
    });
  if (input.agent.enabled && input.outsideModel?.kind === "unavailable")
    add({
      code: "agent_model_outside_unavailable",
      message: `The assistant uses a subscription, and this workspace has no credit-billed model, so ${who} can't use it.`,
      suggestion: "Pick a credit-billed model for the Site's assistant.",
    });
  return warnings.slice(0, 50);
}

export type SiteReadiness = {
  warnings: SitePublishWarning[];
  /** The model people outside the workspace use instead of a subscription model. */
  outsideAgentModel: string | null;
};

/**
 * The readiness of a publication's current version. Any read that fails
 * (no storage, a missing version) leaves that part out rather than failing
 * the publication view.
 */
export async function readSitePublicationReadiness(
  deps: Pick<ApiRouteDeps, "db" | "settings" | "objectStorage">,
  scope: SitePublishingScope,
  publication: Pick<SitePublicationRecord, "siteId" | "access" | "agent">,
): Promise<SiteReadiness> {
  const access = effectiveSiteAccess(publication.access, deps.settings);
  if (access === "members") return { warnings: [], outsideAgentModel: null };
  const siteScope = { ...scope, siteId: publication.siteId };
  const outsideModel = publication.agent.enabled
    ? await resolveSiteOutsideModel(deps, scope, {
        siteId: publication.siteId,
        agentModel: publication.agent.model,
      }).catch(() => null)
    : null;
  const site = await getPublishedSite(deps.db, scope, publication.siteId).catch(() => null);
  const version = site?.currentVersionId
    ? await getPublishedSiteVersion(
        deps.db,
        scope,
        publication.siteId,
        site.currentVersionId,
      ).catch(() => null)
    : null;
  let page: SitePageUsage | null = null;
  if (version && deps.objectStorage && version.sizeBytes <= SITE_READINESS_MAX_HTML_BYTES) {
    const bytes = await deps.objectStorage.getObjectBytes(version.contentKey).catch(() => null);
    if (bytes) page = scanSitePageUsage(new TextDecoder().decode(bytes.bytes));
  }
  const [described, queries] = await Promise.all([
    page && page.collections.size > 0
      ? siteDataStore(deps.db)
          .describe(siteScope)
          .catch(() => null)
      : null,
    page && page.queries.size > 0 ? listSiteSqlQueries(deps.db, siteScope).catch(() => []) : [],
  ]);
  return {
    warnings: siteReadinessWarnings({
      access,
      guestsAllowed: siteGuestsAllowed(publication.access, deps.settings),
      page,
      requestedTools: version?.requestedTools.length ?? 0,
      agent: { enabled: publication.agent.enabled, tools: publication.agent.tools },
      collections: described?.collections ?? [],
      queries,
      outsideModel,
    }),
    outsideAgentModel: outsideModel?.kind === "fallback" ? outsideModel.model : null,
  };
}

/**
 * Apply a readiness warning's safe fix through the ordinary definition
 * paths (the same checks as defining the collection or query by hand): a
 * collection's guest access, or a named query's audience. Everything else
 * about the collection or query stays as it is.
 */
export async function applySitePublishWarningFix(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  scope: SitePublishingScope,
  siteId: string,
  fix: SitePublishWarningFix,
): Promise<void> {
  const siteScope = { ...scope, siteId };
  if (fix.kind === "site_data_guest_access") {
    const collection = await siteDataStore(deps.db).getCollection(siteScope, fix.collection);
    if (!collection)
      throw new SiteFixTargetMissing(`There is no collection named ${fix.collection}`);
    await defineSiteDataCollection(deps, grant, siteId, collection.name, {
      accessMode: collection.accessMode,
      privateRecords: collection.privateRecords,
      guestAccess: fix.guestAccess,
      jsonSchema: collection.jsonSchema,
      indexedFields: collection.indexedFields,
      uniqueFields: collection.uniqueFields,
    });
    return;
  }
  const query = (await listSiteSqlQueries(deps.db, siteScope)).find(
    (candidate) => candidate.name === fix.query,
  );
  if (!query) throw new SiteFixTargetMissing(`There is no query named ${fix.query}`);
  await defineSiteSqlQuery(deps, grant, siteId, query.name, {
    sql: query.sql,
    audience: fix.audience,
    ...(query.description ? { description: query.description } : {}),
    ...(query.maxRows ? { maxRows: query.maxRows } : {}),
  });
}

export class SiteFixTargetMissing extends Error {}
