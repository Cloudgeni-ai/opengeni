import { createHash } from "node:crypto";
import { tool, type Tool } from "@openai/agents";
import { ErrorCode } from "@opengeni/agent-proto";
import { parseLenientSkillFrontmatter, SkillFrontmatterError } from "@opengeni/contracts";
import { z } from "zod";
import {
  assertSkillRelativePath,
  listSkillPaths,
  readSkillFiles,
  SkillFileError,
  SKILL_READ_MAX_PATHS,
  SKILL_READ_MAX_OUTPUT_BYTES,
  type SkillTextFile,
} from "./skill-files";

import {
  Capability,
  SandboxWorkspaceReadNotFoundError,
  type SandboxSessionLike,
} from "@openai/agents/sandbox";
import {
  NotFoundError as ModalNotFoundError,
  SandboxFilesystemFileTooLargeError,
  SandboxFilesystemIsADirectoryError,
  SandboxFilesystemNotADirectoryError,
  SandboxFilesystemNotFoundError,
  SandboxFilesystemPermissionError,
} from "modal";
import { recordModelPreparationMeasurement } from "./model-preparation-diagnostics";
import {
  ChannelASymlinkPathError,
  ChannelAUnavailableError,
  ChannelAUnsupportedError,
  ChannelAValidationError,
  isDefinitePathNotFoundError,
} from "./sandbox/channel-a";
import { withSandboxOperationPurpose } from "./sandbox/operation-purpose";
import {
  classifyProviderSandboxFailure,
  isProviderSandboxGoneDuringRoutedOperation,
} from "./sandbox/provider-errors";
import { SelfhostedControlError } from "./sandbox/selfhosted/control-rpc";

const SKILL_FILE = "SKILL.md";
const MAX_DISCOVERED_SKILLS = 256;
const MAX_SKILL_ENTRIES = 1_024;
const MAX_SKILL_BYTES = 32 * 1024 * 1024;
const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DISCOVERY_CONCURRENCY = 8;

// Keep ordered results, bound remote work, and drain already-started operations
// before propagating a failure. Never leave detached filesystem work behind.
// A failure that must reach turn recovery always outranks the rest, so an
// in-flight real error is never hidden behind a degradable one. An
// unreachable workspace outranks a degradable answer, because its notice
// (sandbox tools may fail) is the more accurate one for the run. Within one
// rank the lowest index wins deterministically.
async function mapDiscovery<T, R>(
  items: readonly T[],
  read: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  let failureIndex = Infinity;
  let failureRank = -1;
  await Promise.all(
    Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          results[index] = await read(items[index]!);
        } catch (error) {
          const rank =
            DISCOVERY_FAILURE_RANK[classifyRepositorySkillDiscoveryFailure(error).handling];
          if (rank > failureRank || (rank === failureRank && index < failureIndex)) {
            failure = error;
            failureIndex = index;
            failureRank = rank;
          }
          failed = true;
        }
      }
    }),
  );
  if (failed) throw failure;
  return results;
}

function isMissingSkillPath(error: unknown): boolean {
  return (
    isDefinitePathNotFoundError(error) ||
    error instanceof SandboxWorkspaceReadNotFoundError ||
    error instanceof SandboxFilesystemNotFoundError
  );
}

/** One search path or skill folder that the workspace answered for but that
 * cannot be used. Only these classes skip a single entry; bounds and a missing
 * file API still degrade the whole index, and everything else propagates. */
const SKIPPABLE_SKILL_PATH_CLASSES = new Set<RepositorySkillDiscoveryErrorClass>([
  "permission_denied",
  "filesystem",
  "symlink",
  "machine_refused",
]);

function skippableSkillPathFailure(error: unknown): RepositorySkillDiscoveryErrorClass | null {
  const failure = classifyRepositorySkillDiscoveryFailure(error);
  return failure.handling === "degraded" && SKIPPABLE_SKILL_PATH_CLASSES.has(failure.errorClass)
    ? failure.errorClass
    : null;
}

/**
 * The bound workspace could not be reached at all: a Connected Machine with no
 * live runner connection (`agentOffline`), or a control request that timed out
 * after the session's own read-only retry (`agent_reconnecting`). Classified
 * only from the typed control error, never from message text. Fencing, consent,
 * payload, OS, and every non-control error are not unreachability.
 */
function isUnreachableWorkspaceError(error: unknown): boolean {
  if (!(error instanceof SelfhostedControlError)) return false;
  if (error.fenced || error.payloadTooLarge) return false;
  return (
    error.agentOffline ||
    error.code === ErrorCode.ERROR_CODE_AGENT_OFFLINE ||
    error.code === ErrorCode.ERROR_CODE_TIMEOUT ||
    error.reason === "agent_reconnecting"
  );
}

/** Discovery found more than its fixed bounds allow. The workspace answered. */
class RepositorySkillDiscoveryLimitError extends Error {
  override readonly name = "RepositorySkillDiscoveryLimitError";
}

/** The bound session cannot list or read files at all. */
class RepositorySkillDiscoveryUnsupportedError extends Error {
  override readonly name = "RepositorySkillDiscoveryUnsupportedError";
}

export type RepositorySkillDiscoveryHandling = "propagated" | "degraded" | "unreachable";

/** Bounded, content-free failure vocabulary for logs, metrics and the notice. */
export const REPOSITORY_SKILL_DISCOVERY_ERROR_CLASSES = [
  "cancelled",
  "fenced",
  "route_changed",
  "sandbox_gone",
  "workspace_unavailable",
  "transport",
  "control_error",
  "provider_error",
  "unclassified",
  "unreachable",
  "permission_denied",
  "filesystem",
  "symlink",
  "machine_refused",
  "unsupported",
  "limit_exceeded",
] as const;

export type RepositorySkillDiscoveryErrorClass =
  (typeof REPOSITORY_SKILL_DISCOVERY_ERROR_CLASSES)[number];

export type RepositorySkillDiscoveryFailure = Readonly<{
  errorClass: RepositorySkillDiscoveryErrorClass;
  handling: RepositorySkillDiscoveryHandling;
}>;

const DISCOVERY_FAILURE_RANK: Record<RepositorySkillDiscoveryHandling, number> = {
  degraded: 0,
  unreachable: 1,
  propagated: 2,
};

/** Typed route and lease transitions that the turn's recovery owns. The
 * worker re-establishes or re-resolves the box and retries the attempt. */
const ROUTE_TRANSITION_ERROR_NAMES = new Set([
  "RoutingBackendRecoveryRequiredError",
  "RoutingWorkspaceRootChangedError",
  "RoutingActiveRouteChangedError",
  "ActiveBackendUnresolvableError",
  "SelfhostedWorkspaceRootChangedError",
  "SandboxCapabilitiesChangedError",
  "ChannelAFileSystemRouteChangedError",
]);

const PERMISSION_ERRNO = new Set(["EACCES", "EPERM"]);
const FILESYSTEM_ERRNO = new Set(["ENOTDIR", "EISDIR", "ELOOP", "ENAMETOOLONG", "EILSEQ", "EFBIG"]);
/** errno codes count only from a filesystem call: `connect EACCES` on a
 * socket is a transport failure, not a skill folder permission. */
const FILESYSTEM_SYSCALLS = new Set([
  "open",
  "opendir",
  "scandir",
  "stat",
  "lstat",
  "fstat",
  "read",
  "readlink",
  "realpath",
  "access",
]);

/** Connected Machine answers that refuse the request itself. Draining,
 * replaced connections, stream, protocol and unspecified control errors are
 * liveness or transport failures and propagate. */
const MACHINE_REFUSAL_CODES = new Set<ErrorCode>([
  ErrorCode.ERROR_CODE_CONSENT_REQUIRED,
  ErrorCode.ERROR_CODE_OS,
  ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE,
  ErrorCode.ERROR_CODE_RUN_AS_UNKNOWN_USER,
  ErrorCode.ERROR_CODE_UNSUPPORTED,
]);

function errorField(error: unknown, key: string): unknown {
  if (!error || typeof error !== "object") return undefined;
  try {
    return (error as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Decide whether a discovery failure may degrade to a run without repository
 * skills. Only evidence that the workspace itself answered, but its skill
 * folders could not be used (permission, not-a-directory, a machine's
 * consent/OS refusal, bounds, no filesystem API), degrades. Everything that
 * says the box or its route could not answer (cancellation, a fence, a route
 * transition, a vanished sandbox, transport loss, any unrecognized error) is
 * propagated so the existing recovery path still sees it before the model
 * runs; masking it would only move the same failure to the first tool call.
 * A Connected Machine that is unreachable keeps its own degraded notice.
 */
export function classifyRepositorySkillDiscoveryFailure(
  error: unknown,
): RepositorySkillDiscoveryFailure {
  const propagated = (errorClass: RepositorySkillDiscoveryErrorClass) =>
    ({ errorClass, handling: "propagated" }) as const;
  const degraded = (errorClass: RepositorySkillDiscoveryErrorClass) =>
    ({ errorClass, handling: "degraded" }) as const;
  try {
    const name = errorField(error, "name");
    const code = errorField(error, "code");
    if (name === "AbortError" || name === "CancelledFailure" || code === "ABORT_ERR")
      return propagated("cancelled");
    if (errorField(error, "fenced") === true) return propagated("fenced");
    if (typeof name === "string" && ROUTE_TRANSITION_ERROR_NAMES.has(name))
      return propagated("route_changed");
    if (error instanceof SelfhostedControlError) {
      if (isUnreachableWorkspaceError(error))
        return { errorClass: "unreachable", handling: "unreachable" };
      if (
        !error.draining &&
        !error.connectionReplaced &&
        (error.payloadTooLarge ||
          error.reason === "consent_required" ||
          MACHINE_REFUSAL_CODES.has(error.code))
      )
        return degraded("machine_refused");
      // Draining, a replaced connection and stream loss are transport; a
      // protocol, unspecified or other control error is still not an answer.
      return propagated(
        error.draining || error.connectionReplaced || error.code === ErrorCode.ERROR_CODE_STREAM
          ? "transport"
          : "control_error",
      );
    }
    if (error instanceof RepositorySkillDiscoveryLimitError) return degraded("limit_exceeded");
    if (
      error instanceof RepositorySkillDiscoveryUnsupportedError ||
      error instanceof ChannelAUnsupportedError ||
      name === "RoutingUnsupportedError"
    )
      return degraded("unsupported");
    if (isProviderSandboxGoneDuringRoutedOperation("modal", error))
      return propagated("sandbox_gone");
    // Modal's filesystem API reports a vanished sandbox as a bare NotFoundError.
    if (error instanceof ModalNotFoundError) return propagated("sandbox_gone");
    // Channel A replaces exec failures during a listing with this class.
    if (error instanceof ChannelAUnavailableError) return propagated("workspace_unavailable");
    if (classifyProviderSandboxFailure("modal", error).kind === "transient_transport")
      return propagated("transport");
    if (error instanceof ChannelASymlinkPathError) return degraded("symlink");
    if (error instanceof SandboxFilesystemPermissionError) return degraded("permission_denied");
    if (
      error instanceof SandboxFilesystemNotADirectoryError ||
      error instanceof SandboxFilesystemIsADirectoryError ||
      error instanceof SandboxFilesystemFileTooLargeError ||
      error instanceof ChannelAValidationError
    )
      return degraded("filesystem");
    // The base Modal SandboxFilesystemError also carries lost gRPC errors and a
    // killed filesystem helper; it is not proof that the workspace answered.
    if (name === "SandboxFilesystemError") return propagated("provider_error");
    const syscall = errorField(error, "syscall");
    if (
      typeof code === "string" &&
      typeof syscall === "string" &&
      FILESYSTEM_SYSCALLS.has(syscall)
    ) {
      if (PERMISSION_ERRNO.has(code)) return degraded("permission_denied");
      if (FILESYSTEM_ERRNO.has(code)) return degraded("filesystem");
    }
  } catch {
    // An unreadable error is not proof that the workspace answered.
  }
  return propagated("unclassified");
}

type WorkspaceSkillDiscovery = Readonly<{
  skills: readonly WorkspaceSkill[];
  warnings: readonly WorkspaceSkillWarning[];
  /** True only when the workspace was unreachable: `skills` is then empty and
   * is not an authoritative "no repository skills" answer. */
  unavailable: boolean;
  /** Set when discovery failed in a way that degrades: `skills` is then empty
   * and is not an authoritative "no repository skills" answer. */
  degraded?: RepositorySkillDiscoveryErrorClass;
}>;

export type WorkspaceSkillWarning = Readonly<{
  code:
    | "invalid_metadata"
    | "invalid_name"
    | "invalid_description"
    | "configured_name_conflict"
    | "conflicting_definitions"
    | "unreadable_search_path"
    | "unreadable_skill";
  paths: readonly string[];
  name?: string;
  /** Bounded, content-free explanation of why the entry was omitted. */
  reason?: string;
}>;

export type WorkspaceSkillSearchPath = Readonly<{
  path: string;
  source: string;
}>;

type WorkspaceSkill = Readonly<{
  name: string;
  description: string;
  path: string;
  source: string;
}>;

type DiscoveredWorkspaceSkill = {
  name: string;
  description: string;
  path: string;
  source: string;
  directory: string;
  fingerprint?: string;
};

/**
 * Index skills that already exist in the live workspace.
 *
 * Unlike the SDK's `skills({ from })` and `skills({ lazyFrom })` sources, this
 * capability deliberately contributes no manifest entries and materializes
 * nothing. Repository resources and Connected Machines already own these
 * files; the bound sandbox session is the one portable way to inspect them.
 */
export class WorkspaceSkillsCapability extends Capability {
  readonly type = "workspace-skills";
  private discovery?: Promise<WorkspaceSkillDiscovery>;

  constructor(
    private readonly searchPaths: readonly WorkspaceSkillSearchPath[],
    private readonly reservedNames: ReadonlySet<string> = new Set(),
    private readonly shadowedNames: ReadonlySet<string> = new Set(),
    private readonly options: WorkspaceSkillsOptions = {},
  ) {
    super();
  }

  override bind(session: SandboxSessionLike): this {
    if (this._session !== session) delete this.discovery;
    return super.bind(session);
  }

  /**
   * Discover once per bound session (one SDK run). An unreachable workspace
   * degrades to an empty, explicitly unavailable index instead of failing
   * instruction preparation: machine unavailability must surface through
   * sandbox tool results, never block the turn before the model runs. The
   * degraded result is memoized only for this binding, so the run keeps a
   * stable instruction prefix and pays the unreachable cost once; the next
   * run clones and rebinds the capability and discovers again.
   *
   * Any other failure that `classifyRepositorySkillDiscoveryFailure` marks
   * degradable (the workspace answered, but its skill folders could not be
   * used) also yields an empty index with a short notice, on every backend.
   * Box, route, fence, transport and cancellation failures still propagate to
   * the turn's recovery path.
   *
   * A propagated failure is not remembered, so the next read discovers again.
   * With a deferred index the reader is often the first workspace operation,
   * where a transient box or route failure is likely; for the same reason a
   * deferred index does not keep an unreachable result either (no prompt text
   * depends on it).
   */
  private discover(): Promise<WorkspaceSkillDiscovery> {
    if (this.discovery) return this.discovery;
    const session = requireWorkspaceSkillSession(this._session);
    const warnings: WorkspaceSkillWarning[] = [];
    const discovery = discoverWorkspaceSkills(
      session,
      this.searchPaths,
      this.reservedNames,
      this._runAs,
      this.shadowedNames,
      (warning) => warnings.push(warning),
    ).then(
      (skills) => ({ skills, warnings, unavailable: false }),
      (error: unknown) => {
        const failure = classifyRepositorySkillDiscoveryFailure(error);
        if (failure.handling === "unreachable") return { skills: [], warnings, unavailable: true };
        if (failure.handling === "degraded")
          return { skills: [], warnings, unavailable: false, degraded: failure.errorClass };
        throw error;
      },
    );
    this.discovery = discovery;
    const forget = () => {
      if (this.discovery === discovery) delete this.discovery;
    };
    discovery.then((result) => {
      if (result.unavailable && this.options.deferred) forget();
    }, forget);
    return discovery;
  }

  override tools(): Tool<unknown>[] {
    return [
      tool({
        name: "repository_skill_read",
        description: this.options.deferred
          ? "Read current repository Skill files from the bound workspace. Name a skill as repository: followed by its SKILL.md path from the workspace root, for a skill folder in one of the folders the Repository skills section lists. Omit paths for SKILL.md; explicit relative paths read only those files. Set listFiles:true without paths for a bounded file inventory. This reads live files through the sandbox, including Connected Machines."
          : "Read current repository Skill files from the bound workspace. Use the exact repository: identifier from the Repository skills index. Omit paths for SKILL.md; explicit relative paths read only those files. Set listFiles:true without paths for a bounded file inventory. This reads live files through the sandbox, including Connected Machines.",
        parameters: z.object({
          skill: z.string().min(1),
          paths: z.array(z.string().min(1).max(1024)).min(1).max(SKILL_READ_MAX_PATHS).optional(),
          listFiles: z.boolean().optional(),
        }),
        execute: async (request) => {
          if (request.listFiles && request.paths !== undefined)
            throw new SkillFileError(
              "invalid_request",
              "listFiles:true cannot be combined with paths.",
            );
          const discovery = await this.discover();
          const skill = discovery.skills.find(
            (entry) => repositorySkillId(entry) === request.skill,
          );
          if (!skill)
            throw new SkillFileError(
              "missing_file",
              repositorySkillMissMessage(discovery, this.options.deferred === true),
            );
          const session = requireWorkspaceSkillSession(this._session);
          const root = skill.path.slice(0, -SKILL_FILE.length - 1);
          const result = request.listFiles
            ? listSkillPaths(
                await repositorySkillInventory(session, root, this._runAs),
                MAX_SKILL_ENTRIES,
              )
            : readSkillFiles(
                await repositorySkillFiles(
                  session,
                  root,
                  request.paths ?? [SKILL_FILE],
                  this._runAs,
                ),
                request.paths,
              );
          const output = JSON.stringify({
            skillId: request.skill,
            source: "repository",
            root,
            ...result,
          });
          if (new TextEncoder().encode(output).byteLength > SKILL_READ_MAX_OUTPUT_BYTES) {
            throw new SkillFileError(
              "output_too_large",
              "Repository Skill response exceeds the read output limit. Request fewer paths.",
            );
          }
          return output;
        },
      }),
    ];
  }

  override async instructions(): Promise<string | null> {
    if (this.options.deferred) return deferredRepositorySkillsNotice(this.searchPaths);
    const { skills, warnings, unavailable, degraded } = await this.discover();
    const warningText = warnings.length
      ? `\n\n### Skipped repository skills\nThese repository entries were omitted because their folders could not be read or their metadata or names conflict. Other skills remain available; correct the source files to use the omitted entries.\n${warnings.map((warning) => `- ${JSON.stringify(warning)}`).join("\n")}`
      : "";
    if (unavailable) {
      return `## Repository skills

Repository skills could not be indexed because the workspace was unreachable when this run started (for example, its Connected Machine is offline). Sandbox tools may fail until it reconnects; if that blocks the task, tell the user.${warningText}`;
    }

    if (degraded) {
      return `## Repository skills

${degradedRepositorySkillsNotice(degraded)}${warningText}`;
    }
    if (skills.length === 0) return warnings.length ? `## Repository skills${warningText}` : null;

    const available = skills
      .map(
        (skill) =>
          `- ${JSON.stringify({ id: repositorySkillId(skill), name: skill.name, description: skill.description, reader: "repository_skill_read", path: skill.path })}`,
      )
      .join("\n");
    return `## Repository skills

Repository skills are instructions already present in the live workspace. Read them with repository_skill_read using the exact repository: id below. The reader returns current live files; ordinary filesystem tools execute referenced scripts and read binary assets. Configured Skills use their separate skill_read index.

### Available repository skills
${available}

### How to use repository skills
- If the user names a skill, or the task clearly matches a skill description, read its complete SKILL.md before acting.
- Resolve referenced scripts, references, assets, and templates relative to that skill directory.
- Use only the minimum relevant skills for the turn, and say briefly which ones you are using.
- Do not assume a skill remains applicable on later turns; evaluate the current request again.${warningText}`;
  }
}

export type WorkspaceSkillsOptions = Readonly<{
  /**
   * Do not index the workspace for this run: listing it would be the first
   * workspace operation and would prepare the workspace before the model
   * answers. The model is told where to look instead; the instructions never
   * touch the session, and the reader still works for exact identifiers.
   */
  deferred?: boolean;
}>;

/** Where to look, instead of an index that would prepare the workspace first. */
function deferredRepositorySkillsNotice(searchPaths: readonly WorkspaceSkillSearchPath[]): string {
  const folders = searchPaths.map((searchPath) => searchPath.path).join(", ");
  const example = searchPaths[0]?.path ?? ".agents/skills";
  return `## Repository skills

Repository skills are not listed here: the repository may not be ready until a tool first uses the workspace. If the task involves the repository, look for skill folders in ${folders} (paths from the workspace root), and read any relevant one's SKILL.md before acting, with file tools or repository_skill_read. A skill's identifier is repository: followed by its SKILL.md path, such as repository:${example}/<folder>/SKILL.md.`;
}

const MISS_LISTED_SKILLS = 20;
const MISS_LISTED_WARNINGS = 5;

/** A miss says why: the identifiers that do exist, the folders that were
 * skipped and their reason, or that the skill folders could not be read. */
function repositorySkillMissMessage(discovery: WorkspaceSkillDiscovery, deferred: boolean): string {
  const { skills, warnings, unavailable, degraded } = discovery;
  const skipped = warnings.length
    ? ` Skipped: ${warnings
        .slice(0, MISS_LISTED_WARNINGS)
        .map((warning) => `${warning.paths.join(", ")} (${warning.reason ?? warning.code})`)
        .join(
          "; ",
        )}${warnings.length > MISS_LISTED_WARNINGS ? `; and ${warnings.length - MISS_LISTED_WARNINGS} more` : ""}.`
    : "";
  // A deferred reader discovers again on the next call; a live index keeps
  // what it found when the run started, so a retry there cannot succeed.
  if (unavailable)
    return deferred
      ? `Repository skills could not be read: the workspace is unreachable. Try again once workspace tools respond.${skipped}`
      : `Repository skills could not be read: the workspace was unreachable when this run started. Once workspace tools respond, read the skill's SKILL.md with file tools.${skipped}`;
  if (degraded)
    return `Repository skills could not be read (${degradedRepositorySkillsCause(degraded)}). Read the skill's SKILL.md with file tools instead.${skipped}`;
  const missing = deferred
    ? "No repository skill has this identifier."
    : "Repository Skill is not in this index.";
  if (!skills.length) return `${missing} No repository skills were found.${skipped}`;
  const listed = skills.slice(0, MISS_LISTED_SKILLS).map(repositorySkillId).join(", ");
  const more =
    skills.length > MISS_LISTED_SKILLS ? `, and ${skills.length - MISS_LISTED_SKILLS} more` : "";
  return `${missing} Use one of these exact identifiers: ${listed}${more}.${skipped}`;
}

function degradedRepositorySkillsCause(errorClass: RepositorySkillDiscoveryErrorClass): string {
  return errorClass === "unsupported"
    ? "this workspace cannot list files"
    : errorClass === "limit_exceeded"
      ? "too many skill folders or files"
      : errorClass === "permission_denied"
        ? "permission denied"
        : errorClass === "machine_refused"
          ? "the machine refused the request"
          : "the skill folders could not be read";
}

/** Short, class-specific model notice for an index that could not be built. */
function degradedRepositorySkillsNotice(errorClass: RepositorySkillDiscoveryErrorClass): string {
  if (errorClass === "unsupported")
    return "Repository skills are not indexed for this run (this workspace cannot list files).";
  return `Repository skills are not indexed for this run (${degradedRepositorySkillsCause(errorClass)}). If a repository skill matters, try reading its SKILL.md directly.`;
}

export function workspaceSkills(
  searchPaths: readonly WorkspaceSkillSearchPath[],
  reservedNames: Iterable<string> = [],
  shadowedNames: Iterable<string> = [],
  options: WorkspaceSkillsOptions = {},
): WorkspaceSkillsCapability {
  return new WorkspaceSkillsCapability(
    searchPaths,
    new Set([...reservedNames].map((name) => name.toLowerCase())),
    new Set([...shadowedNames].map((name) => name.toLowerCase())),
    options,
  );
}

export async function discoverWorkspaceSkills(
  session: SandboxSessionLike,
  searchPaths: readonly WorkspaceSkillSearchPath[],
  reservedNames: ReadonlySet<string> = new Set(),
  runAs?: string,
  shadowedNames: ReadonlySet<string> = new Set(),
  onWarning?: (warning: WorkspaceSkillWarning) => void,
): Promise<readonly WorkspaceSkill[]> {
  const startedAt = performance.now();
  let outcome: "completed" | "failed" = "completed";
  let failure: RepositorySkillDiscoveryFailure | undefined;
  const skipped: RepositorySkillDiscoveryErrorClass[] = [];
  try {
    return await withSandboxOperationPurpose("repository_skills", () =>
      discoverWorkspaceSkillsUnmeasured(
        session,
        searchPaths,
        reservedNames,
        runAs,
        shadowedNames,
        (warning) => {
          console.warn("Repository skill skipped", warning);
          onWarning?.(warning);
        },
        (errorClass) => skipped.push(errorClass),
      ),
    );
  } catch (error) {
    outcome = "failed";
    try {
      failure = classifyRepositorySkillDiscoveryFailure(error);
      // Bounded class only: provider messages may contain repository paths or content.
      console.warn("Repository skill discovery failed", failure);
    } catch {
      // Telemetry never changes discovery behavior.
    }
    throw error;
  } finally {
    recordModelPreparationMeasurement({
      phase: "repository_skill_discovery",
      outcome,
      durationSeconds: (performance.now() - startedAt) / 1_000,
      count: searchPaths.length,
      ...(failure ? { failure } : {}),
      ...(skipped.length ? { skipped } : {}),
    });
  }
}

async function discoverWorkspaceSkillsUnmeasured(
  session: SandboxSessionLike,
  searchPaths: readonly WorkspaceSkillSearchPath[],
  reservedNames: ReadonlySet<string>,
  runAs: string | undefined,
  shadowedNames: ReadonlySet<string>,
  warn: (warning: WorkspaceSkillWarning) => void,
  onSkip: (errorClass: RepositorySkillDiscoveryErrorClass) => void,
): Promise<readonly WorkspaceSkill[]> {
  type SkippedEntry = Readonly<{
    code: "unreadable_search_path" | "unreadable_skill";
    path: string;
    reason: RepositorySkillDiscoveryErrorClass;
  }>;
  const skip = ({ code, path, reason }: SkippedEntry, quiet = false) => {
    onSkip(reason);
    if (quiet) {
      console.info("Repository skill folder skipped", { code, reason });
      return;
    }
    warn({ code, paths: [path], reason });
  };
  if (!session.listDir || !session.readFile) {
    throw new RepositorySkillDiscoveryUnsupportedError(
      "Workspace skill discovery requires sandbox listDir() and readFile() support",
    );
  }
  const discovered = new Map<string, DiscoveredWorkspaceSkill>();
  const conflictingNames = new Set<string>();
  const listed = await mapDiscovery(searchPaths, async (searchPath) => {
    try {
      return {
        entries: await session.listDir!({ path: searchPath.path, ...(runAs ? { runAs } : {}) }),
      };
    } catch (error) {
      if (isMissingSkillPath(error)) return { entries: [] };
      // The workspace answered but this folder cannot be used (for example a
      // symlinked search path the file API refuses): skip only this path.
      const reason = skippableSkillPathFailure(error);
      if (!reason) throw error;
      return {
        entries: [],
        skipped: { code: "unreadable_search_path", path: searchPath.path, reason } as const,
      };
    }
  });
  // A symlinked search path is excluded like a symlinked skill entrypoint: the
  // confined file API cannot prove its target stays in the workspace. When a
  // sibling search path under the same root has skill folders (the usual
  // `.claude/skills -> ../.agents/skills`), the link's skills are indexed
  // there, so the model is not told about it. Otherwise it is listed, so
  // skills behind a link to an unindexed folder never vanish silently.
  listed.forEach(({ skipped }, index) => {
    if (!skipped) return;
    const root = searchPathRoot(searchPaths[index]!.path);
    const coveredBySibling =
      skipped.reason === "symlink" &&
      listed.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          !other.skipped &&
          searchPathRoot(searchPaths[otherIndex]!.path) === root &&
          other.entries.some((entry) => entry.type === "dir"),
      );
    skip(skipped, coveredBySibling);
  });
  const roots = listed.map(({ entries }) => entries);
  const candidates = roots.flatMap((entries, index) =>
    [...entries]
      .sort((left, right) => left.name.localeCompare(right.name))
      .filter((entry) => entry.type === "dir")
      .map((entry) => ({ entry, searchPath: searchPaths[index]! })),
  );
  if (candidates.length > MAX_DISCOVERED_SKILLS) {
    throw new RepositorySkillDiscoveryLimitError(
      `Repository skill discovery exceeds ${MAX_DISCOVERED_SKILLS} directories`,
    );
  }
  const loaded = await mapDiscovery(candidates, async ({ entry, searchPath }) => {
    const skillMarkdownPath = joinWorkspacePath(entry.path, SKILL_FILE);
    let markdown: string;
    try {
      // Match reader/inventory eligibility: symlink entrypoints are not
      // advertised because the portable filesystem API cannot prove containment.
      const skillEntries = await session.listDir!({
        path: entry.path,
        ...(runAs ? { runAs } : {}),
      });
      if (
        !skillEntries.some(
          (candidate) => candidate.name === SKILL_FILE && candidate.type === "file",
        )
      )
        return null;
      const content = await session.readFile!({
        path: skillMarkdownPath,
        ...(runAs ? { runAs } : {}),
      });
      markdown = typeof content === "string" ? content : new TextDecoder().decode(content);
    } catch (error) {
      if (isMissingSkillPath(error)) return null;
      const reason = skippableSkillPathFailure(error);
      if (!reason) throw error;
      return { skipped: { code: "unreadable_skill", path: entry.path, reason } as const };
    }
    const warning = (code: WorkspaceSkillWarning["code"], reason: string, name?: string) => ({
      warning: { code, paths: [skillMarkdownPath], ...(name ? { name } : {}), reason },
    });
    let frontmatter: ReturnType<typeof parseLenientSkillFrontmatter>;
    try {
      frontmatter = parseLenientSkillFrontmatter(markdown);
    } catch (error) {
      // Only repository metadata parsing is degradable. Transport, permission,
      // cancellation and managed/explicit Skill validation still fail normally.
      // Do not log YAML parser messages: they may include repository content.
      return warning(
        "invalid_metadata",
        error instanceof SkillFrontmatterError ? error.reason : "unreadable_header",
      );
    }
    if (frontmatter.fallbackReason) {
      // Key names and the bounded parser code only, never values.
      console.info("Repository skill metadata read with the lenient fallback", {
        path: skillMarkdownPath,
        reason: frontmatter.fallbackReason,
        keys: frontmatter.keys ?? [],
      });
    }
    const name = frontmatter.name?.trim() || entry.name;
    if (name.length > 64 || !SAFE_SKILL_NAME.test(name)) {
      return warning(
        "invalid_name",
        "name must be 1-64 letters, digits, dots, underscores or hyphens, starting with a letter or digit",
      );
    }
    const key = name.toLowerCase();
    if (shadowedNames.has(key)) return null;
    const description = frontmatter.description?.trim() || "No description provided.";
    if (description.length > 2_048) {
      return warning("invalid_description", "description is longer than 2048 characters", name);
    }
    if (reservedNames.has(key)) {
      return warning("configured_name_conflict", "a configured Skill already uses this name", name);
    }
    const candidate: DiscoveredWorkspaceSkill = {
      name,
      description,
      path: skillMarkdownPath,
      source: searchPath.source,
      directory: entry.path,
    };
    return candidate;
  });
  for (const candidate of loaded) {
    if (!candidate) continue;
    if ("skipped" in candidate) {
      skip(candidate.skipped);
      continue;
    }
    if ("warning" in candidate) {
      warn(candidate.warning);
      continue;
    }
    const { name } = candidate;
    const key = name.toLowerCase();
    // Once ambiguous, never resurrect a name from a third search path.
    if (conflictingNames.has(key)) continue;
    const existing = discovered.get(key);
    if (!existing) {
      discovered.set(key, candidate);
      continue;
    }
    // Unique names only need SKILL.md frontmatter for the prompt-cache prefix.
    // Hash both trees only when the same name appears in two search paths.
    const existingFingerprint =
      existing.fingerprint ??
      (await fingerprintWorkspaceDirectory(session, existing.directory, runAs));
    const candidateFingerprint = await fingerprintWorkspaceDirectory(
      session,
      candidate.directory,
      runAs,
    );
    if (existingFingerprint !== candidateFingerprint) {
      discovered.delete(key);
      conflictingNames.add(key);
      warn({
        code: "conflicting_definitions",
        name,
        paths: [existing.path, candidate.path],
        reason: "two skill folders define this name with different files",
      });
      continue;
    }
    existing.fingerprint = existingFingerprint;
  }
  return [...discovered.values()]
    .map(({ name, description, path, source }) => ({ name, description, path, source }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** The workspace or repository folder a search path such as
 * `repo/.claude/skills` belongs to (`repo`). */
function searchPathRoot(path: string): string {
  return path.split("/").filter(Boolean).slice(0, -2).join("/");
}

async function fingerprintWorkspaceDirectory(
  session: SandboxSessionLike,
  root: string,
  runAs?: string,
): Promise<string> {
  const hash = createHash("sha256");
  let entryCount = 0;
  let byteCount = 0;

  async function visit(path: string, relativePath: string): Promise<void> {
    const entries = await session.listDir!({ path, ...(runAs ? { runAs } : {}) });
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      entryCount += 1;
      if (entryCount > MAX_SKILL_ENTRIES) {
        throw new RepositorySkillDiscoveryLimitError(
          `Workspace skill exceeds ${MAX_SKILL_ENTRIES} filesystem entries`,
        );
      }
      const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      hash.update(entry.type);
      hash.update("\0");
      hash.update(childRelativePath);
      hash.update("\0");
      if (entry.type === "dir") {
        await visit(entry.path, childRelativePath);
        continue;
      }
      if (entry.type !== "file") continue;
      const content = await session.readFile!({
        path: entry.path,
        ...(runAs ? { runAs } : {}),
      });
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      byteCount += bytes.byteLength;
      if (byteCount > MAX_SKILL_BYTES) {
        throw new RepositorySkillDiscoveryLimitError(
          `Workspace skill exceeds ${MAX_SKILL_BYTES} bytes`,
        );
      }
      hash.update(bytes);
      hash.update("\0");
    }
  }

  await visit(root, "");
  return hash.digest("hex");
}

function repositorySkillId(skill: WorkspaceSkill): string {
  return `repository:${skill.path}`;
}

/** Resolve only ordinary directory entries under the discovered Skill root.
 * Never treat a caller identifier as a path or follow a listed symlink. The
 * bound sandbox remains the filesystem authority, including concurrent edits.
 */
async function repositorySkillFiles(
  session: SandboxSessionLike,
  root: string,
  paths: readonly string[],
  runAs?: string,
): Promise<SkillTextFile[]> {
  // Validate the entire request before touching the filesystem.
  readSkillFiles(
    paths.map((path) => ({ path, content: "" })),
    paths,
  );
  const files: SkillTextFile[] = [];
  for (const path of paths) {
    let directory = root;
    const segments = path.split("/");
    for (const [index, name] of segments.entries()) {
      const entries = await session.listDir!({ path: directory, ...(runAs ? { runAs } : {}) });
      const entry = entries.find((candidate) => candidate.name === name);
      const expected = index === segments.length - 1 ? "file" : "dir";
      if (entry?.type !== expected)
        throw new SkillFileError("missing_file", `Repository Skill file is unavailable: ${path}`);
      directory = joinWorkspacePath(directory, name);
    }
    const content = await session.readFile!({ path: directory, ...(runAs ? { runAs } : {}) });
    files.push({
      path,
      content:
        typeof content === "string"
          ? content
          : new TextDecoder("utf-8", { fatal: true }).decode(content),
    });
    // Bound aggregate output as each file arrives; do not truncate accepted text.
    readSkillFiles(
      files,
      files.map((file) => file.path),
    );
  }
  return files;
}

async function repositorySkillInventory(
  session: SandboxSessionLike,
  root: string,
  runAs?: string,
): Promise<SkillTextFile[]> {
  const files: SkillTextFile[] = [];
  let count = 0;
  async function visit(relative: string): Promise<void> {
    const entries = await session.listDir!({
      path: relative ? joinWorkspacePath(root, relative) : root,
      ...(runAs ? { runAs } : {}),
    });
    for (const entry of entries) {
      if (++count > MAX_SKILL_ENTRIES)
        throw new SkillFileError("output_too_large", "Repository Skill inventory is too large.");
      // Paths derive from validated names, never provider-returned absolute paths.
      assertSkillRelativePath(entry.name);
      if (entry.name.includes("/"))
        throw new SkillFileError("invalid_path", "Invalid repository directory entry.");
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.type === "dir") await visit(path);
      else if (entry.type === "file") files.push({ path, content: "" });
    }
  }
  await visit("");
  return files;
}

function joinWorkspacePath(parent: string, child: string): string {
  return `${parent.replace(/\/+$/, "")}/${child}`;
}

function requireWorkspaceSkillSession(session: SandboxSessionLike | undefined): SandboxSessionLike {
  if (!session) {
    throw new Error('capability "workspace-skills" used before bind(session)');
  }
  return session;
}
