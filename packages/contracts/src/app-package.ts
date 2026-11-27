import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";
import {
  WORKSPACE_ARTIFACT_DESCRIPTION_MAX_CHARS,
  WORKSPACE_ARTIFACT_TITLE_MAX_CHARS,
  WorkspaceArtifact,
  WorkspaceArtifactHtml,
  WorkspaceArtifactRequestedTools,
  WorkspaceArtifactSourceBundle,
  WorkspaceArtifactVisibility,
} from "./artifacts";
import { SiteAssetBundle } from "./app-assets";
import { SiteDataCollectionDefinitionRequest } from "./site-data";
import {
  SITE_SQL_IDENTIFIER,
  SITE_SQL_NAME,
  SiteSqlQueryDefinitionRequest,
  SiteSqlValueSchema,
} from "./site-sql";
import { SIDEBAR_LABEL_MAX_CHARS, SidebarAppPath } from "./sidebar-layout";
import { SkillFile } from "./skills";
import { readSkillMetadata } from "./skill-metadata";
import { SKILL_MAX_FILES, validateSkillTextFiles } from "./skill-files";
import { ToolGatewayIdentity } from "./tool-catalog";

/**
 * An app package: one JSON file that carries an app (a Site) to another
 * workspace. It holds the app's current version (HTML and optional source),
 * the tools it declares, its Site Data collection definitions, its Site SQL
 * migrations and named queries, its syncs, where it sits in the sidebar, and
 * optional bounded demo data. It never holds the app's real data. See docs/app-packages.md.
 */
export const APP_PACKAGE_FORMAT = "opengeni.app-package";
export const APP_PACKAGE_VERSION = 1;
/** A package file is at most this large (the API reads it in one request). */
export const APP_PACKAGE_MAX_BYTES = 24 * 1024 * 1024;
/** Demo data limits: records per collection, rows per table and bytes in all. */
export const APP_PACKAGE_DEMO_RECORDS_PER_COLLECTION = 1_000;
export const APP_PACKAGE_DEMO_ROWS_PER_TABLE = 5_000;
export const APP_PACKAGE_DEMO_MAX_BYTES = 8 * 1024 * 1024;
/** Shared Site files in demo data: at most this many (their bytes count toward the demo budget). */
export const APP_PACKAGE_DEMO_FILES_MAX = 200;
export const APP_PACKAGE_SYNCS_MAX = 50;
export const APP_PACKAGE_SIDEBAR_MAX = 10;
/** Skills a package can carry, and automations (scheduled agent runs). */
export const APP_PACKAGE_SKILLS_MAX = 10;
export const APP_PACKAGE_AUTOMATIONS_MAX = 5;
/** An automation's instructions for each run, at most this many characters. */
export const APP_PACKAGE_AUTOMATION_PROMPT_MAX_CHARS = 8_000;
/** Earlier states of an installed app kept to go back to (see docs/app-packages.md#updates-and-going-back). */
export const APP_PACKAGE_SNAPSHOTS_KEPT = 3;
/** How long a package file `app_export` stores for download is kept. */
export const APP_PACKAGE_EXPORT_TTL_SECONDS = 24 * 60 * 60;

const Name = primitives.string.regex(SITE_SQL_NAME);

/** A package's own version label, such as "1.2.0": up to three dot-separated numbers. */
export const AppPackageVersionLabel = /* @__PURE__ */ defineSchema(() =>
  primitives.string.regex(/^\d{1,6}(?:\.\d{1,6}){0,2}$/u),
);

/**
 * Compares two package version labels by their numbers ("1.10" is after
 * "1.9"; "1" equals "1.0.0"). Negative when `a` is older.
 */
export function compareAppPackageVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * A Skill the package carries: its SKILL.md folder. Install adds it as a
 * workspace Skill linked to the app; its name and description come from
 * SKILL.md.
 */
export const AppPackageSkillFiles = /* @__PURE__ */ defineSchema(() =>
  z.object({ files: z.array(SkillFile).min(1).max(SKILL_MAX_FILES) }),
);
export type AppPackageSkill = { name: string; description: string; files: SkillFile[] };

/**
 * An automation the package carries: a scheduled agent run, added switched
 * off. `{{appId}}` in its prompt becomes the installed app's id. The
 * schedule is an automation schedule (`ScheduledTaskScheduleSpec`), checked
 * when it is added.
 */
export const AppPackageAutomation = /* @__PURE__ */ defineSchema(() =>
  z.object({
    name: primitives.string.trim().min(1).max(200),
    prompt: primitives.string.trim().min(1).max(APP_PACKAGE_AUTOMATION_PROMPT_MAX_CHARS),
    schedule: z.record(primitives.string, z.unknown()),
  }),
);
export type AppPackageAutomation = z.infer<typeof AppPackageAutomation>;

export const AppPackageCollection = /* @__PURE__ */ defineSchema(() =>
  SiteDataCollectionDefinitionRequest.extend({ name: Name }),
);
export type AppPackageCollection = z.infer<typeof AppPackageCollection>;

export const AppPackageMigration = /* @__PURE__ */ defineSchema(() =>
  z.object({ name: Name, sql: primitives.nonEmptyString.max(2 * 1024 * 1024) }),
);
export type AppPackageMigration = z.infer<typeof AppPackageMigration>;

export const AppPackageQuery = /* @__PURE__ */ defineSchema(() =>
  SiteSqlQueryDefinitionRequest.extend({
    name: Name,
    description: z.string().max(2000).nullable().optional(),
    maxRows: SiteSqlQueryDefinitionRequest.shape.maxRows.nullable(),
  }),
);
export type AppPackageQuery = z.infer<typeof AppPackageQuery>;

/**
 * A sync definition (an automation that fills app data from a connected
 * tool), kept as plain JSON: the sync feature owns its shape. Installed syncs
 * start paused until the installer confirms the account they use.
 */
export const AppPackageSync = /* @__PURE__ */ defineSchema(() =>
  z.record(primitives.string, z.unknown()),
);
export type AppPackageSync = z.infer<typeof AppPackageSync>;

/**
 * Where the app sits in the workspace's default sidebar: one link, optionally
 * to one of its pages, with its own label and the name of the group it is in.
 */
export const AppPackageSidebarItem = /* @__PURE__ */ defineSchema(() =>
  z.object({
    // A getter, read when parsing: the sidebar's chunk can import this one back.
    get path() {
      return SidebarAppPath.optional();
    },
    label: primitives.string.trim().min(1).max(SIDEBAR_LABEL_MAX_CHARS).optional(),
    group: primitives.string.trim().min(1).max(SIDEBAR_LABEL_MAX_CHARS).optional(),
  }),
);
export type AppPackageSidebarItem = z.infer<typeof AppPackageSidebarItem>;

export const AppPackageDemoRecord = /* @__PURE__ */ defineSchema(() =>
  z.object({
    key: primitives.string.min(1).max(512).nullable().optional(),
    data: z.record(primitives.string, z.unknown()),
  }),
);
export type AppPackageDemoRecord = z.infer<typeof AppPackageDemoRecord>;

/**
 * A SQL value in demo rows: text, number, boolean, null, or a blob as
 * `{ "$base64": "…" }` (the same tag Site SQL JSON exports use).
 */
export const AppPackageSqlValue = /* @__PURE__ */ defineSchema(() =>
  z.union([
    SiteSqlValueSchema,
    z.object({
      $base64: primitives.string.max(8 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/u),
    }),
  ]),
);
export type AppPackageSqlValue = z.infer<typeof AppPackageSqlValue>;

export const AppPackageSqlRow = /* @__PURE__ */ defineSchema(() =>
  z.record(primitives.string, AppPackageSqlValue),
);
export type AppPackageSqlRow = z.infer<typeof AppPackageSqlRow>;

/**
 * One of the app's shared Site files in demo data. `id` is its id in the
 * exporting app: install gives the copy a new id and rewrites demo values
 * that are exactly the old id.
 */
export const AppPackageDemoFile = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid.optional(),
    name: primitives.string.trim().min(1).max(255),
    contentType: primitives.string.min(1).max(255),
    base64: primitives.string.max(16 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/u),
  }),
);
export type AppPackageDemoFile = z.infer<typeof AppPackageDemoFile>;

export type AppPackage = {
  format: typeof APP_PACKAGE_FORMAT;
  version: number;
  /**
   * The app's id across its packages: every export of one app (and of copies
   * installed from it) carries the same id, so an upgrade can tell a newer
   * version of the same app from a different app. Absent in older packages.
   */
  packageId?: string | undefined;
  /**
   * The package's own version label ("1.2.0"). A ready-made app with a later
   * version than the one an app was installed from offers an update. Absent
   * in older packages.
   */
  packageVersion?: string | undefined;
  exportedAt: string;
  app: {
    title: string;
    description: string | null;
    html: string;
    /** Retained editable source; absent for HTML-only apps. */
    source?: z.infer<typeof WorkspaceArtifactSourceBundle> | undefined;
    /** A multi-file build's asset files (JS, CSS, fonts, images) beside the HTML. */
    assets?: SiteAssetBundle | undefined;
  };
  /** The tools the app declares; installers connect their own accounts. */
  tools: ToolGatewayIdentity[];
  data: { collections: AppPackageCollection[] };
  sql: { migrations: AppPackageMigration[]; queries: AppPackageQuery[] };
  syncs: AppPackageSync[];
  /** The app's links in the exporting workspace's default sidebar. */
  sidebar?: AppPackageSidebarItem[] | undefined;
  /** Skills that come with the app (SKILL.md folders). Absent in older packages. */
  skills?: AppPackageSkill[] | undefined;
  /** Automations (scheduled agent runs) that come with the app, added switched off. */
  automations?: AppPackageAutomation[] | undefined;
  /** Present only when the author chose to include demo data. */
  demoData?:
    | {
        records: Record<string, AppPackageDemoRecord[]>;
        sqlRows: Record<string, AppPackageSqlRow[]>;
        /** The app's shared Site files (never private ones). Absent in older packages. */
        files?: AppPackageDemoFile[] | undefined;
      }
    | undefined;
};

/** Something in a package that was left out of an export or an install, and why. */
export type AppPackageProblem = {
  part:
    | "package"
    | "app"
    | "version"
    | "tools"
    | "collection"
    | "sql"
    | "migration"
    | "query"
    | "sync"
    | "sidebar"
    | "skill"
    | "automation"
    | "demo_data";
  name?: string | undefined;
  reason: string;
};

/** POST .../published-artifacts/:id/package: what to put in the package. */
export const AppPackageExportRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    demoData: z
      .union([
        primitives.boolean,
        z.object({
          collections: z.array(Name).max(100).optional(),
          tables: z.array(primitives.string.regex(SITE_SQL_IDENTIFIER)).max(100).optional(),
          files: primitives.boolean
            .optional()
            .describe("Include the app's shared files (never private ones)."),
        }),
      ])
      .optional()
      .describe(
        "Include demo data: true for every shared collection, table and shared file, or name the collections and tables (and files: true). Omitted: no data.",
      ),
  }),
);
export type AppPackageExportRequest = z.infer<typeof AppPackageExportRequest>;

export type AppPackageExportResponse = {
  package: AppPackage;
  /** A file name for the package, such as team-board.opengeni-app.json. */
  filename: string;
  /** Parts left out of the package, such as demo data past its limits. */
  notExported: AppPackageProblem[];
};

/** POST /v1/workspaces/:workspaceId/app-packages/install */
export const AppPackageInstallRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    package: z.record(primitives.string, z.unknown()).describe("The package file's JSON."),
    title: primitives.string.trim().min(1).max(WORKSPACE_ARTIFACT_TITLE_MAX_CHARS).optional(),
    visibility: WorkspaceArtifactVisibility.optional(),
    demoData: primitives.boolean
      .optional()
      .describe("Install the package's demo data (default true when it has some)."),
    idempotencyKey: primitives.string.trim().min(1).max(200),
  }),
);
export type AppPackageInstallRequest = z.infer<typeof AppPackageInstallRequest>;

export type AppPackageInstallResponse = {
  app: z.infer<typeof WorkspaceArtifact>;
  /** The package the app was installed from, or null for a package without one. */
  packageId?: string | null;
  /** The same request was installed before; this is that app. */
  replayed: boolean;
  installed: {
    tools: number;
    collections: string[];
    migrations: string[];
    queries: string[];
    syncs: string[];
    /** Sidebar links added, to the default sidebar or the installer's own. */
    sidebar: number;
    demoRecords: number;
    demoRows: number;
    /** Shared Site files loaded from the demo data. */
    demoFiles?: number;
    /** The package's Skills, by name, added (or already linked) as workspace Skills. */
    skills?: string[];
    /** The package's automations, by name, added switched off. */
    automations?: string[];
  };
  /** What couldn't be installed; the rest was. */
  notInstalled: AppPackageProblem[];
};

export type ParsedAppPackage = { package: AppPackage; problems: AppPackageProblem[] };

/** POST .../published-artifacts/:id/package/upgrade */
export const AppPackageUpgradeRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      package: z
        .record(primitives.string, z.unknown())
        .optional()
        .describe("The package file's JSON. Give it, or `previous`."),
      previous: z
        .union([primitives.boolean, primitives.string.uuid()])
        .optional()
        .describe(
          "Go back to a saved earlier state of the app instead of a package: its id (from the app's status `previous.id`, so a retry applies the same one), or true for the latest.",
        ),
      dryRun: primitives.boolean.optional().describe("Only return the plan; nothing changes."),
      allowDestructive: primitives.boolean
        .optional()
        .describe(
          "Apply changes the plan marks destructive (they could hide, reassign or delete existing data).",
        ),
      idempotencyKey: primitives.string
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe("Required to apply; the same key and package apply once."),
    })
    .refine((value) => (value.package === undefined) !== !value.previous, {
      message: "Give exactly one of package or previous",
      path: ["package"],
    }),
);
export type AppPackageUpgradeRequest = z.infer<typeof AppPackageUpgradeRequest>;

/**
 * What upgrading an app from a package changes. Nothing is ever deleted:
 * collections and syncs the package doesn't have are kept. Each list names
 * collections, migrations, queries or syncs.
 */
export type AppPackageUpgradePlan = {
  /** Whether the package's version differs from the app's current one. */
  version: {
    changed: boolean;
    html: boolean;
    source: boolean;
    tools: boolean;
    /** Whether the multi-file build's asset files differ (absent from older servers). */
    assets?: boolean;
  };
  /**
   * The package's id and the one the app came from (null when unknown). A
   * different one is listed in `destructive`: it is another app's package.
   */
  package?: { id: string | null; current: string | null };
  tools: { added: ToolGatewayIdentity[]; removed: ToolGatewayIdentity[] };
  collections: {
    added: string[];
    changed: string[];
    unchanged: string[];
    kept: string[];
  };
  migrations: { applied: string[]; new: string[]; conflicting: string[] };
  queries: {
    added: string[];
    changed: string[];
    removed: string[];
    unchanged: string[];
  };
  syncs: {
    added: string[];
    changed: string[];
    unchanged: string[];
    kept: string[];
  };
  /** Changes that could hide, reassign or delete existing data: applying needs `allowDestructive`. */
  destructive: AppPackageProblem[];
  /** The app's version label now and the package's (null when unknown). Absent from older servers. */
  packageVersion?: { current: string | null; next: string | null };
  /**
   * The package's Skills, by name: `added` (new workspace Skills), `changed`
   * (their files differ and are replaced), `unchanged`, and `kept`: Skills
   * that came with the app that the package no longer has (they stay).
   */
  skills?: { added: string[]; changed: string[]; unchanged: string[]; kept: string[] };
  /** Automations, by name: `added` switched off; the app's existing ones are `kept` as they are. */
  automations?: { added: string[]; kept: string[] };
  /** What stops the upgrade; nothing is applied while there is any. */
  conflicts: AppPackageProblem[];
  /** Parts of the package that are ignored or won't apply, and why. */
  problems: AppPackageProblem[];
};

export type AppPackageUpgradeResponse = {
  /** The app after the upgrade (unchanged for a dry run). */
  app: z.infer<typeof WorkspaceArtifact>;
  dryRun: boolean;
  /** Whether the upgrade ran (false for a dry run). */
  applied: boolean;
  plan: AppPackageUpgradePlan;
  /**
   * What this request changed. Every step skips what is already done (and
   * the same key publishes the version once), so a retry lists only what was
   * still left.
   */
  upgraded: {
    version: boolean;
    collections: string[];
    migrations: string[];
    queries: string[];
    syncs: string[];
    /** Skills added or updated. */
    skills?: string[];
    /** Automations added (switched off). */
    automations?: string[];
  };
  /** What couldn't be upgraded; the rest was. */
  notUpgraded: AppPackageProblem[];
};

export class AppPackageFormatError extends Error {
  readonly name = "AppPackageFormatError";
}

/**
 * An installed app's package state (GET .../app-packages/status): where it
 * came from, whether it was edited here since, its Skills and automations,
 * whether it can go back to its state before the last upgrade, and whether
 * a ready-made app offers a later version.
 */
export type AppPackageStatus = {
  appId: string;
  title: string;
  packageId: string | null;
  packageVersion: string | null;
  /** Archived apps are listed too: their Skills stay, labelled with the app. */
  archived: boolean;
  /**
   * The app or one of its Skills was changed here since its install or last
   * upgrade. A customized app is forked for good: it gets no package updates
   * (`update` and `previous` are null, and upgrades are refused).
   */
  customized: boolean;
  skills: Array<{
    id: string;
    name: string;
    /** Its files were changed here since the package wrote them. */
    modified: boolean;
  }>;
  automations: Array<{ id: string; name: string }>;
  /** Its saved state before the last upgrade, to go back to; null when there is none. */
  previous: { id: string; packageVersion: string | null; savedAt: string } | null;
  /** A ready-made app with the same package and a later version; null when there is none. */
  update: { templateKey: string; packageVersion: string } | null;
};

export type ListAppPackageStatusResponse = { apps: AppPackageStatus[] };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function issue(error: z.ZodError): string {
  return error.issues
    .slice(0, 2)
    .map((entry) => `${entry.path.join(".") || "value"}: ${entry.message}`)
    .join("; ");
}

function itemName(value: unknown, fallback: string): string {
  const name = record(value)?.name;
  return typeof name === "string" && name.length > 0 ? name.slice(0, 128) : fallback;
}

/**
 * Read a package leniently: only the format and the app's HTML are required.
 * Unknown fields are ignored, and each collection, migration, query, sync or
 * demo set that doesn't validate is left out and reported instead of failing
 * the whole package. Throws AppPackageFormatError when it isn't an app
 * package at all.
 */
export function parseAppPackage(value: unknown): ParsedAppPackage {
  const root = record(value);
  if (!root || root.format !== APP_PACKAGE_FORMAT)
    throw new AppPackageFormatError(
      `This isn't an app package (format must be "${APP_PACKAGE_FORMAT}")`,
    );
  const problems: AppPackageProblem[] = [];
  const version =
    typeof root.version === "number" && Number.isInteger(root.version) && root.version > 0
      ? root.version
      : null;
  if (version === null)
    throw new AppPackageFormatError("This app package has no valid version number");
  if (version > APP_PACKAGE_VERSION)
    problems.push({
      part: "package",
      reason: `Made by a newer Opengeni (package version ${version}); parts this version doesn't know were ignored`,
    });
  const app = record(root.app);
  const html = WorkspaceArtifactHtml.safeParse(app?.html);
  if (!app || !html.success) throw new AppPackageFormatError("This app package has no app HTML");
  const title =
    typeof app.title === "string" && app.title.trim().length > 0
      ? app.title.trim().slice(0, WORKSPACE_ARTIFACT_TITLE_MAX_CHARS)
      : "Installed app";
  const description =
    typeof app.description === "string"
      ? app.description.slice(0, WORKSPACE_ARTIFACT_DESCRIPTION_MAX_CHARS)
      : null;
  let assets: SiteAssetBundle | undefined;
  if (app.assets !== undefined && app.assets !== null) {
    const parsed = SiteAssetBundle.safeParse(app.assets);
    // The HTML loads these files, so the app would be broken without them.
    if (!parsed.success)
      throw new AppPackageFormatError(
        `This app package's asset files are invalid (${issue(parsed.error)})`,
      );
    assets = parsed.data;
  }
  const packageId = primitives.uuid.safeParse(root.packageId);
  const packageVersion = AppPackageVersionLabel.safeParse(root.packageVersion);
  if (root.packageVersion !== undefined && root.packageVersion !== null && !packageVersion.success)
    problems.push({
      part: "package",
      name: "packageVersion",
      reason: 'Its version label isn\'t numbers like "1.2.0" and was ignored',
    });
  let source: AppPackage["app"]["source"];
  if (app.source !== undefined && app.source !== null) {
    const parsed = WorkspaceArtifactSourceBundle.safeParse(app.source);
    if (parsed.success) source = parsed.data;
    else
      problems.push({
        part: "app",
        name: "source",
        reason: `Its editable source was invalid and left out (${issue(parsed.error)}); the app itself installs`,
      });
  }

  const list = <T>(
    raw: unknown,
    schema: z.ZodType<T>,
    part: AppPackageProblem["part"],
    label: string,
  ): T[] => {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      problems.push({ part, reason: `${label} isn't a list and was ignored` });
      return [];
    }
    const items: T[] = [];
    for (const [index, entry] of raw.entries()) {
      const parsed = schema.safeParse(entry);
      if (parsed.success) items.push(parsed.data);
      else
        problems.push({
          part,
          name: itemName(entry, `#${index + 1}`),
          reason: `Invalid (${issue(parsed.error)})`,
        });
    }
    return items;
  };

  let tools: ToolGatewayIdentity[] = [];
  const rawTools = list(root.tools, ToolGatewayIdentity, "tools", "tools");
  const checkedTools = WorkspaceArtifactRequestedTools.safeParse(rawTools);
  if (checkedTools.success) tools = checkedTools.data;
  else {
    const seen = new Set<string>();
    tools = rawTools
      .filter((tool) => {
        const key = `${tool.serverId}\u0000${tool.toolName}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 128);
    if (tools.length < rawTools.length)
      problems.push({ part: "tools", reason: "Repeated or extra tools were left out" });
  }

  const data = record(root.data);
  const collections = list(
    data?.collections,
    AppPackageCollection,
    "collection",
    "data.collections",
  );
  const sql = record(root.sql);
  const migrations = list(sql?.migrations, AppPackageMigration, "migration", "sql.migrations");
  const queries = list(sql?.queries, AppPackageQuery, "query", "sql.queries");
  const syncs = list(root.syncs, AppPackageSync, "sync", "syncs");
  if (syncs.length > APP_PACKAGE_SYNCS_MAX) {
    problems.push({
      part: "sync",
      reason: `Only the first ${APP_PACKAGE_SYNCS_MAX} syncs were read`,
    });
    syncs.length = APP_PACKAGE_SYNCS_MAX;
  }

  const sidebar = list(root.sidebar, AppPackageSidebarItem, "sidebar", "sidebar");
  if (sidebar.length > APP_PACKAGE_SIDEBAR_MAX) {
    problems.push({
      part: "sidebar",
      reason: `Only the first ${APP_PACKAGE_SIDEBAR_MAX} sidebar links were read`,
    });
    sidebar.length = APP_PACKAGE_SIDEBAR_MAX;
  }

  // Skills: each a SKILL.md folder whose name and description are read from it.
  const skills: AppPackageSkill[] = [];
  for (const [index, entry] of list(
    root.skills,
    AppPackageSkillFiles,
    "skill",
    "skills",
  ).entries()) {
    if (skills.length >= APP_PACKAGE_SKILLS_MAX) {
      problems.push({
        part: "skill",
        reason: `Only the first ${APP_PACKAGE_SKILLS_MAX} Skills were read`,
      });
      break;
    }
    try {
      validateSkillTextFiles(entry.files);
      const main = entry.files.find((file) => file.path === "SKILL.md");
      if (!main) throw new Error("It has no SKILL.md");
      const metadata = readSkillMetadata(main.content);
      if (skills.some((skill) => skill.name === metadata.name))
        throw new Error(`Another Skill in the package is named ${metadata.name}`);
      skills.push({
        ...metadata,
        files: entry.files.map(({ path, content }) => ({ path, content })),
      });
    } catch (error) {
      problems.push({
        part: "skill",
        name: `Skill ${index + 1}`,
        reason: `Invalid and left out (${error instanceof Error ? error.message : String(error)})`,
      });
    }
  }

  const automations = list(root.automations, AppPackageAutomation, "automation", "automations");
  if (automations.length > APP_PACKAGE_AUTOMATIONS_MAX) {
    problems.push({
      part: "automation",
      reason: `Only the first ${APP_PACKAGE_AUTOMATIONS_MAX} automations were read`,
    });
    automations.length = APP_PACKAGE_AUTOMATIONS_MAX;
  }

  let demoData: AppPackage["demoData"];
  const demo = record(root.demoData);
  if (demo) {
    const records: Record<string, AppPackageDemoRecord[]> = {};
    const sqlRows: Record<string, AppPackageSqlRow[]> = {};
    for (const [name, raw] of Object.entries(record(demo.records) ?? {})) {
      const parsed = z
        .array(AppPackageDemoRecord)
        .max(APP_PACKAGE_DEMO_RECORDS_PER_COLLECTION)
        .safeParse(raw);
      if (parsed.success && SITE_SQL_NAME.test(name)) records[name] = parsed.data;
      else
        problems.push({
          part: "demo_data",
          name,
          reason: parsed.success ? "Invalid collection name" : `Invalid (${issue(parsed.error)})`,
        });
    }
    for (const [name, raw] of Object.entries(record(demo.sqlRows) ?? {})) {
      const parsed = z.array(AppPackageSqlRow).max(APP_PACKAGE_DEMO_ROWS_PER_TABLE).safeParse(raw);
      if (parsed.success && SITE_SQL_IDENTIFIER.test(name)) sqlRows[name] = parsed.data;
      else
        problems.push({
          part: "demo_data",
          name,
          reason: parsed.success ? "Invalid table name" : `Invalid (${issue(parsed.error)})`,
        });
    }
    const files: AppPackageDemoFile[] = [];
    if (demo.files !== undefined && demo.files !== null) {
      if (!Array.isArray(demo.files))
        problems.push({
          part: "demo_data",
          reason: "demoData.files isn't a list and was ignored",
        });
      else
        for (const [index, entry] of demo.files.entries()) {
          if (files.length >= APP_PACKAGE_DEMO_FILES_MAX) {
            problems.push({
              part: "demo_data",
              reason: `Only the first ${APP_PACKAGE_DEMO_FILES_MAX} files were read`,
            });
            break;
          }
          const parsed = AppPackageDemoFile.safeParse(entry);
          if (parsed.success) files.push(parsed.data);
          else
            problems.push({
              part: "demo_data",
              name: itemName(entry, `file ${index + 1}`),
              reason: `Invalid file (${issue(parsed.error)})`,
            });
        }
    }
    if (Object.keys(records).length > 0 || Object.keys(sqlRows).length > 0 || files.length > 0)
      demoData = { records, sqlRows, ...(files.length > 0 ? { files } : {}) };
  }

  return {
    package: {
      format: APP_PACKAGE_FORMAT,
      version,
      ...(packageId.success ? { packageId: packageId.data } : {}),
      ...(packageVersion.success ? { packageVersion: packageVersion.data } : {}),
      exportedAt: typeof root.exportedAt === "string" ? root.exportedAt : "",
      app: {
        title,
        description,
        html: html.data,
        ...(source ? { source } : {}),
        ...(assets ? { assets } : {}),
      },
      tools,
      data: { collections },
      sql: { migrations, queries },
      syncs,
      ...(sidebar.length > 0 ? { sidebar } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(automations.length > 0 ? { automations } : {}),
      ...(demoData ? { demoData } : {}),
    },
    problems,
  };
}

/** A file name for an app's package: its title in lowercase words. */
export function appPackageFilename(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base || "app"}.opengeni-app.json`;
}
