// packages/runtime/src/sandbox/channel-a.ts — the Channel-A structured services
// (P4.4 / modules/08-channel-a.md §4), provider-agnostic, called API-DIRECT.
//
// THE NON-PIXEL SURFACE: file tree + read/write (the Pierre tree), git
// status/diff hunks (the Pierre diff), and a terminal exec + interactive PTY.
// Served client -> API -> box IN-PROCESS: the API resumes the box by id, builds
// ONE service around the live `session` handle for the call's lifetime, runs the
// op, returns inline JSON, and drops the handle. There is NO ownership/singleton
// here — the live handle is whatever the caller resumed; it is non-owned and
// dropped when the call returns. The same module is importable by the worker's
// agent-turn for the A1 fs.changed side-effect it produces in-process.
//
// SDK GROUNDING (the load-bearing reality — see the adversarial review in the
// module spec). Built on `session.exec(args): Promise<SandboxExecResult>` which
// returns RAW {stdout,stderr,exitCode} on the agents-core local/docker sessions
// (and Modal/the extensions providers expose the equivalent). `execCommand`
// returns a BANNER-DECORATED string (formatExecResponse) — NEVER used for
// parsing; only as a last-resort fallback when `exec` is absent, with the banner
// stripped. `readFile` returns string|Uint8Array (binary-safe). Writes go
// through `exec` (a base64 heredoc — raw + binary capable, unlike createEditor's
// apply-patch-only path which cannot do binary, C4), falling back to
// `createEditor` for text when `exec` is absent.

import type {
  FsChangedPayload,
  FsDeleteRequest,
  FsDeleteResponse,
  FsListRequest,
  FsListResponse,
  FsMkdirRequest,
  FsMkdirResponse,
  FsMoveRequest,
  FsMoveResponse,
  FsReadRequest,
  FsReadResponse,
  FsTreeNode,
  FsWriteRequest,
  FsWriteResponse,
  GitChangedPayload,
  GitCommit,
  GitDiffHunk,
  GitDiffRequest,
  GitDiffResponse,
  GitFileDiff,
  GitFileStatus,
  GitFileStatusCode,
  GitLogRequest,
  GitLogResponse,
  GitShowRequest,
  GitShowResponse,
  GitStatusRequest,
  GitStatusResponse,
  PtyCloseRequest,
  PtyOpenRequest,
  PtyOpenResponse,
  PtyResizeRequest,
  PtyWriteRequest,
  SessionEventType,
  SessionStructuredCapabilities,
  TerminalExecRequest,
  TerminalExecResponse,
} from "@opengeni/contracts";

// ── The minimal session surface Channel A consumes (a structural subset of the
// SDK's SandboxSession, all optional — capability-probed before use). ─────────
export type ChannelAExecResult = {
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  sessionId?: number;
  wallTimeSeconds?: number;
};
export type ChannelAExecArgs = {
  cmd: string;
  workdir?: string | undefined;
  shell?: string | undefined;
  login?: boolean | undefined;
  tty?: boolean | undefined;
  yieldTimeMs?: number | undefined;
  maxOutputTokens?: number | undefined;
  runAs?: string | undefined;
};
export type ChannelAEditor = {
  createFile?(op: unknown): Promise<unknown>;
  updateFile?(op: unknown): Promise<unknown>;
  deleteFile?(op: unknown): Promise<unknown>;
};
export type ChannelASession = {
  exec?(args: ChannelAExecArgs): Promise<ChannelAExecResult>;
  execCommand?(args: ChannelAExecArgs): Promise<string>;
  readFile?(args: {
    path: string;
    runAs?: string;
    maxBytes?: number;
  }): Promise<string | Uint8Array>;
  writeStdin?(args: {
    sessionId: number;
    chars?: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
  }): Promise<string>;
  createEditor?(runAs?: string): ChannelAEditor;
  supportsPty?(): boolean;
};

// ── Errors mapped to HTTP status at the route. ───────────────────────────────
export class ChannelAValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelAValidationError";
  }
}
export class ChannelAConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelAConflictError";
  }
}
export class ChannelANotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelANotFoundError";
  }
}
export class ChannelAUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelAUnsupportedError";
  }
}

export type ChannelAEmitter = (
  events: { type: SessionEventType; payload: unknown }[],
) => Promise<void>;

export type SandboxChannelAServiceOptions = {
  session: ChannelASession;
  // The workspace-relative root the box maps "" to (the SDK normalizes against
  // its own workspaceRoot, so "" is the workspace root here).
  workspaceRoot?: string;
  // The lease epoch the box was resumed under (paired with `revision` for cache
  // invalidation — H3). 0 when ownership is off / no lease.
  leaseEpoch?: number;
  // The starting FS revision (monotonic; the caller may seed it from a prior
  // value so it doesn't reset to 0 mid-session — H3). Defaults to 0.
  revision?: number;
  // A1 emitter — appendAndPublishEvents bound to the caller's db+bus. Optional:
  // a pure read (fsList/fsRead/gitDiff) needs no emitter; only the mutating /
  // PTY paths emit. When absent the notification is silently skipped.
  emit?: ChannelAEmitter;
  // runAs is omitted unless the backend supports it (modal/daytona/cloudflare);
  // e2b/runloop/blaxel/vercel throw on runAs (SDK survey). Default off — the
  // local/docker test backends are single-user.
  runAs?: string;
};

export const REPOSITORY_DISCOVERY_LIMIT = 256;
export type RepositoryDiscoveryDegradedReason =
  | "command_failed"
  | "command_timed_out"
  | "result_limit_exceeded";
export type RepositoryDiscoveryResult = {
  repos: string[];
  complete: boolean;
  degradedReason: RepositoryDiscoveryDegradedReason | null;
};

const REPOSITORY_DISCOVERY_TRUNCATED_SENTINEL = "__OPENGENI_REPOSITORY_DISCOVERY_TRUNCATED__";
const REPOSITORY_DISCOVERY_STATUS_PREFIX = "__OPENGENI_REPOSITORY_DISCOVERY_STATUS__:";

const NUL = String.fromCharCode(0); // \0 NUL — find/porcelain/numstat -z separator
const US = String.fromCharCode(0x1f); // \x1f unit sep — git-log field separator
const RS = String.fromCharCode(0x1e); // \x1e record sep — git-log record separator
const SELFHOSTED_VIRTUAL_ROOT = "/workspace";

export class SandboxChannelAService {
  private readonly session: ChannelASession;
  private readonly workspaceRoot: string;
  private readonly leaseEpoch: number;
  private revision: number;
  private readonly emit?: ChannelAEmitter | undefined;
  private readonly runAs?: string | undefined;

  constructor(opts: SandboxChannelAServiceOptions) {
    this.session = opts.session;
    this.workspaceRoot = opts.workspaceRoot ?? "";
    this.leaseEpoch = opts.leaseEpoch ?? 0;
    this.revision = opts.revision ?? 0;
    this.emit = opts.emit;
    this.runAs = opts.runAs;
  }

  /** Capability probe — the compact Channel-A projection. */
  capabilities(repos: string[] = []): SessionStructuredCapabilities {
    const s = this.session;
    const hasExec = Boolean(s.exec || s.execCommand);
    const hasFs = Boolean(s.readFile && (s.exec || s.execCommand || s.createEditor));
    return {
      FileSystem: {
        available: hasFs,
        readOnly: !(s.exec || s.createEditor),
        root: this.workspaceRoot,
      },
      Terminal: {
        events: hasExec,
        exec: hasExec,
        pty: { available: Boolean(s.supportsPty?.() && s.writeStdin) },
      },
      Git: { available: hasExec, repos },
    };
  }

  // ════════════════════════════ exec primitive ══════════════════════════════
  // RAW exec — returns {stdout, stderr, exitCode}. Uses session.exec when present
  // (the local/docker sessions return raw output); falls back to execCommand +
  // a banner strip (last resort; banner-truncation can mangle, so exec is always
  // preferred). Throws ChannelAUnsupportedError when neither exists.
  private async run(args: ChannelAExecArgs): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    sessionId?: number;
    wallTimeSeconds: number;
  }> {
    const withRunAs = this.runAs ? { ...args, runAs: this.runAs } : args;
    if (this.session.exec) {
      const r = await this.session.exec(withRunAs);
      return {
        stdout: r.stdout ?? r.output ?? "",
        stderr: r.stderr ?? "",
        exitCode: r.exitCode ?? null,
        ...(typeof r.sessionId === "number" ? { sessionId: r.sessionId } : {}),
        wallTimeSeconds: r.wallTimeSeconds ?? 0,
      };
    }
    if (this.session.execCommand) {
      const raw = await this.session.execCommand(withRunAs);
      // The SDK's execCommand returns the formatExecResponse BANNER string. When a
      // command stays running (an interactive `bash` opened with tty:true), the
      // banner carries a `Process running with session ID <N>` line — the numeric
      // exec-session id writeStdin() needs to drive that PTY. The exec() fast-path
      // above surfaces sessionId structurally; this fallback must recover it from
      // the banner or the PTY appears non-interactive (execSessionId=null ->
      // pty/write 409) even on backends (Modal) whose only exec surface is
      // execCommand. We DON'T close over the banner for stdout (that is stripped).
      const sessionId = parseExecBannerSessionId(raw);
      return {
        stdout: stripExecBanner(raw),
        stderr: "",
        exitCode: null,
        ...(sessionId !== null ? { sessionId } : {}),
        wallTimeSeconds: 0,
      };
    }
    throw new ChannelAUnsupportedError("the box does not support command execution");
  }

  // ════════════════════════════ FileSystem (A2) ═════════════════════════════

  async fsList(req: FsListRequest): Promise<FsListResponse> {
    const root = normalizeRelPath(req.path);
    // A single bounded `find` (NUL-delimited) builds the whole subtree in one
    // round-trip. Prefer GNU find's -printf on the Ubuntu-based images, but fall
    // back to a POSIX-ish find+stat loop for unix_local on macOS/BSD.
    const findRoot = root === "" ? "." : shellQuote(root);
    const depthArg = Math.max(1, req.depth);
    const hidden = req.includeHidden ? "" : ` -not -path '*/.*'`;
    const gnuFind = `find ${findRoot} -mindepth 1 -maxdepth ${depthArg}${hidden} -printf '%y\\t%s\\t%T@\\t%m\\t%p\\0' 2>/dev/null`;
    let { stdout } = await this.run({
      cmd: `bash -lc ${shellQuote(gnuFind)}`,
      workdir: this.workspaceRoot || undefined,
    });
    if (!stdout) {
      const portableFind = [
        `find ${findRoot} -mindepth 1 -maxdepth ${depthArg}${hidden} -print0 2>/dev/null | while IFS= read -r -d '' p; do`,
        `if [ -d "$p" ]; then t=d; size=0; elif [ -f "$p" ]; then t=f; size=$(wc -c < "$p" | tr -d ' '); elif [ -L "$p" ]; then t=l; size=0; else t=o; size=0; fi;`,
        `mtime=$(date -r "$p" +%s 2>/dev/null || stat -c %Y "$p" 2>/dev/null || echo 0);`,
        `mode=$(stat -f %Lp "$p" 2>/dev/null || stat -c %a "$p" 2>/dev/null || echo 0);`,
        `printf '%s\\t%s\\t%s\\t%s\\t%s\\0' "$t" "$size" "$mtime" "$mode" "$p";`,
        `done`,
      ].join(" ");
      ({ stdout } = await this.run({
        cmd: `bash -lc ${shellQuote(portableFind)}`,
        workdir: this.workspaceRoot || undefined,
      }));
    }

    const entries = stdout.split(NUL).filter((s) => s.length > 0);
    const rootNode: FsTreeNode = {
      name: basename(root) || (root === "" ? "" : root),
      path: root,
      type: "dir",
      sizeBytes: null,
      mtimeMs: null,
      mode: null,
      children: [],
      truncated: false,
    };
    // Index nodes by path for O(1) parent attach.
    const byPath = new Map<string, FsTreeNode>();
    byPath.set(root, rootNode);
    let count = 0;
    let truncated = false;
    for (const entry of entries) {
      if (count >= req.maxEntries) {
        truncated = true;
        break;
      }
      const parts = entry.split("\t");
      if (parts.length < 5) continue;
      const [typeChar, sizeStr, mtimeStr, modeStr, ...pathParts] = parts;
      const rawPath = pathParts.join("\t");
      const relPath = stripDotSlash(rawPath, root);
      const node: FsTreeNode = {
        name: basename(relPath),
        path: relPath,
        type: findTypeToNode(typeChar ?? ""),
        sizeBytes: typeChar === "d" ? null : safeInt(sizeStr),
        mtimeMs: mtimeToMs(mtimeStr),
        mode: safeOctal(modeStr),
        ...(typeChar === "d" ? { children: [] as FsTreeNode[] } : {}),
        truncated: false,
      };
      byPath.set(relPath, node);
      count++;
    }
    // Second pass: attach each node to its parent (parents always present
    // because find emits ancestors before descendants at increasing depth).
    for (const [path, node] of byPath) {
      if (path === root) continue;
      const parentPath = dirnameRel(path, root);
      const parent = byPath.get(parentPath) ?? rootNode;
      (parent.children ??= []).push(node);
    }
    sortTree(rootNode);
    return { root: rootNode, revision: this.revision, truncated };
  }

  async fsRead(req: FsReadRequest): Promise<FsReadResponse> {
    const path = assertSafeRelPath(req.path);
    if (!this.session.readFile) {
      // No native readFile: base64 the file through exec (binary-safe).
      return await this.fsReadViaExec(path, req);
    }
    let raw: string | Uint8Array;
    try {
      raw = await this.session.readFile({
        path: this.joinRoot(path),
        maxBytes: req.maxBytes,
        ...(this.runAs ? { runAs: this.runAs } : {}),
      });
    } catch (error) {
      // The provider's native readFile applies a REMOTE workspace-escape guard:
      // a SYMLINK whose target resolves outside /workspace (e.g.
      // `.config/pulse/<id>-runtime -> /tmp/pulse-…`) is rejected with
      // "Sandbox path failed remote validation: workspace escape: /tmp/…". That
      // raw 404 surfaced to the user. The path is still legitimately INSIDE the
      // workspace (the symlink node lives there); only its target escapes. Read it
      // via exec instead — `base64 <path>` follows the link and is NOT subject to
      // the provider's path validation — so a symlink-to-/tmp renders cleanly
      // instead of erroring. A genuine not-found falls through to a clean 404.
      if (isWorkspaceEscapeError(error)) {
        return await this.fsReadViaExec(path, req);
      }
      throw new ChannelANotFoundError(
        `file not found: ${path} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
    return this.shapeRead(path, bytes, req);
  }

  /** Read a file by base64-ing it through exec. Binary-safe and — crucially —
   *  NOT subject to the provider's native-readFile workspace-escape validation,
   *  so it can render a symlink whose target lives outside /workspace (the link
   *  node itself is in-workspace). `base64 <path>` follows the symlink. */
  private async fsReadViaExec(path: string, req: FsReadRequest): Promise<FsReadResponse> {
    const abs = this.joinRoot(path);
    const { stdout, exitCode } = await this.run({
      cmd: `base64 ${shellQuote(abs)} 2>/dev/null | head -c ${Math.ceil(req.maxBytes * 1.4)}`,
    });
    if (exitCode !== null && exitCode !== 0 && stdout === "") {
      // The target may be a dangling symlink or a link to a directory; surface a
      // clean, typed not-found rather than a raw provider validation error.
      throw new ChannelANotFoundError(`file not found: ${path}`);
    }
    const bytes = Buffer.from(stdout.replace(/\n/g, ""), "base64");
    return this.shapeRead(path, bytes, req);
  }

  private shapeRead(path: string, bytes: Buffer, req: FsReadRequest): FsReadResponse {
    const truncated = bytes.byteLength >= req.maxBytes;
    const isBinary = sniffBinary(bytes);
    const encoding = req.encoding === "base64" || isBinary ? "base64" : "utf8";
    const content = encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf8");
    return {
      path,
      encoding,
      content,
      sizeBytes: bytes.byteLength,
      truncated,
      isBinary,
      revision: this.revision,
    };
  }

  async fsWrite(req: FsWriteRequest): Promise<FsWriteResponse> {
    const path = assertSafeRelPath(req.path);
    const abs = this.joinRoot(path);
    const bytes =
      req.encoding === "base64"
        ? Buffer.from(req.content, "base64")
        : Buffer.from(req.content, "utf8");

    if (!req.overwrite) {
      const { exitCode } = await this.run({ cmd: `test -e ${shellQuote(abs)}` });
      if (exitCode === 0) {
        throw new ChannelAConflictError(`path exists and overwrite is false: ${path}`);
      }
    }
    if (req.createParents) {
      const dir = dirnameAbs(abs);
      if (dir) await this.run({ cmd: `mkdir -p ${shellQuote(dir)}` });
    }
    // base64-decode heredoc — raw + binary capable, single round-trip, last-
    // writer-wins (the I4 default; no read-modify-write race because we write
    // the whole file). A non-existent parent with createParents:false surfaces a
    // non-zero exit -> 400.
    const b64 = bytes.toString("base64");
    const { exitCode, stderr } = await this.run({
      cmd: `printf %s ${shellQuote(b64)} | base64 -d > ${shellQuote(abs)}`,
    });
    if (exitCode !== null && exitCode !== 0) {
      // createEditor fallback for text when exec-write failed and we have a
      // text payload (binary cannot go through apply-patch).
      if (req.encoding !== "base64" && this.session.createEditor) {
        const ok = await this.tryEditorWrite(abs, req.content);
        if (!ok)
          throw new ChannelAValidationError(
            `failed to write ${path}: ${stderr || `exit ${exitCode}`}`,
          );
      } else {
        throw new ChannelAValidationError(
          `failed to write ${path}: ${stderr || `exit ${exitCode}`}`,
        );
      }
    }
    this.revision++;
    await this.emitFsChanged(
      [{ path, kind: "modified", isDir: false, sizeBytes: bytes.byteLength }],
      "write",
    );
    return { path, sizeBytes: bytes.byteLength, revision: this.revision };
  }

  private async tryEditorWrite(absPath: string, content: string): Promise<boolean> {
    const editor = this.session.createEditor?.(this.runAs);
    if (!editor?.createFile) return false;
    try {
      // The apply-patch op shape — a whole-file "create" diff (last-writer-wins).
      const diff = content
        .split("\n")
        .map((line) => `+${line}`)
        .join("\n");
      await editor.createFile({ type: "create_file", path: absPath, diff });
      return true;
    } catch {
      return false;
    }
  }

  async fsDelete(req: FsDeleteRequest): Promise<FsDeleteResponse> {
    const path = assertSafeRelPath(req.path);
    const abs = this.joinRoot(path);
    const flag = req.recursive ? "-rf" : "-f";
    const { exitCode, stderr } = await this.run({ cmd: `rm ${flag} ${shellQuote(abs)}` });
    if (exitCode !== null && exitCode !== 0) {
      throw new ChannelAValidationError(
        `failed to delete ${path}: ${stderr || `exit ${exitCode}`}`,
      );
    }
    this.revision++;
    await this.emitFsChanged([{ path, kind: "deleted", isDir: false, sizeBytes: null }], "write");
    return { revision: this.revision };
  }

  async fsMove(req: FsMoveRequest): Promise<FsMoveResponse> {
    const path = assertSafeRelPath(req.path);
    const newPath = assertSafeRelPath(req.newPath);
    const abs = this.joinRoot(path);
    const newAbs = this.joinRoot(newPath);

    if (!req.overwrite) {
      const { exitCode } = await this.run({ cmd: `test -e ${shellQuote(newAbs)}` });
      if (exitCode === 0) {
        throw new ChannelAConflictError(`destination exists and overwrite is false: ${newPath}`);
      }
    }
    if (req.createParents) {
      const dir = dirnameAbs(newAbs);
      if (dir) await this.run({ cmd: `mkdir -p ${shellQuote(dir)}` });
    }
    // -f only when overwrite — otherwise a clobber would silently succeed past
    // the guard above on a race. A missing source surfaces a non-zero exit -> 400.
    const flag = req.overwrite ? "-f " : "";
    const { exitCode, stderr } = await this.run({
      cmd: `mv ${flag}${shellQuote(abs)} ${shellQuote(newAbs)}`,
    });
    if (exitCode !== null && exitCode !== 0) {
      throw new ChannelAValidationError(
        `failed to move ${path} -> ${newPath}: ${stderr || `exit ${exitCode}`}`,
      );
    }
    this.revision++;
    await this.emitFsChanged(
      [
        { path, kind: "deleted", isDir: false, sizeBytes: null },
        { path: newPath, kind: "created", isDir: false, sizeBytes: null },
      ],
      "write",
    );
    return { path, newPath, revision: this.revision };
  }

  async fsMkdir(req: FsMkdirRequest): Promise<FsMkdirResponse> {
    const path = assertSafeRelPath(req.path);
    const abs = this.joinRoot(path);
    // A plain mkdir on an existing path returns non-zero -> 400, matching the
    // write-on-existing semantics; -p makes the create idempotent + builds parents.
    const flag = req.recursive ? "-p " : "";
    const { exitCode, stderr } = await this.run({ cmd: `mkdir ${flag}${shellQuote(abs)}` });
    if (exitCode !== null && exitCode !== 0) {
      throw new ChannelAValidationError(`failed to mkdir ${path}: ${stderr || `exit ${exitCode}`}`);
    }
    this.revision++;
    await this.emitFsChanged([{ path, kind: "created", isDir: true, sizeBytes: null }], "write");
    return { path, revision: this.revision };
  }

  // ════════════════════════════ Git (A2, read-only) ═════════════════════════

  async gitStatus(req: GitStatusRequest): Promise<GitStatusResponse> {
    const repo = this.repoWorkdir(req.path);
    const inside = await this.run({
      cmd: "git rev-parse --is-inside-work-tree 2>/dev/null",
      workdir: repo,
    });
    if (inside.stdout.trim() !== "true") {
      return {
        isRepo: false,
        head: null,
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        revision: this.revision,
      };
    }
    const { stdout } = await this.run({
      cmd: "git status --porcelain=v2 --branch -z",
      workdir: repo,
    });
    return { ...parsePorcelainV2(stdout), revision: this.revision };
  }

  async gitDiff(req: GitDiffRequest): Promise<GitDiffResponse> {
    const repo = this.repoWorkdir(req.path);
    const ctx = req.contextLines;
    // Selector precedence: refs > staged > worktree.
    let range = "";
    if (req.fromRef && req.toRef) range = `${shellQuote(req.fromRef)} ${shellQuote(req.toRef)}`;
    else if (req.fromRef) range = `${shellQuote(req.fromRef)}`;
    else if (req.staged) range = "--cached";
    const pathspec = req.pathspec.length ? ` -- ${req.pathspec.map(shellQuote).join(" ")}` : "";

    // Pass 1: numstat (stats + binary detection). -z gives NUL-separated fields;
    // a rename emits old\0new for that record's path fields.
    const numstat = await this.run({
      cmd: `git -c core.quotePath=false diff --no-color -z --numstat ${range}${pathspec}`.trim(),
      workdir: repo,
    });
    const stats = parseNumstatZ(numstat.stdout);

    const files: GitFileDiff[] = [];
    for (const stat of stats) {
      const target = stat.newPath;
      const fileStatus: GitFileStatusCode = stat.binary ? "modified" : "modified";
      if (stat.binary) {
        files.push({
          path: target,
          oldPath: stat.oldPath,
          status: fileStatus,
          isBinary: true,
          isImage: isImagePath(target),
          additions: 0,
          deletions: 0,
          hunks: [],
          truncated: false,
        });
        continue;
      }
      // Pass 2: the per-file unified patch -> hunks.
      const patch = await this.run({
        cmd: `git -c core.quotePath=false diff --no-color -U${ctx} ${range} -- ${shellQuote(target)}`.trim(),
        workdir: repo,
      });
      const oversized = Buffer.byteLength(patch.stdout, "utf8") > req.maxBytesPerFile;
      const parsed = oversized
        ? { hunks: [] as GitDiffHunk[], status: "modified" as GitFileStatusCode }
        : parseUnifiedPatch(patch.stdout);
      files.push({
        path: target,
        oldPath: stat.oldPath,
        status: parsed.status,
        isBinary: false,
        isImage: isImagePath(target),
        additions: stat.additions,
        deletions: stat.deletions,
        hunks: parsed.hunks,
        truncated: oversized,
      });
    }
    return { files, revision: this.revision };
  }

  async gitLog(req: GitLogRequest): Promise<GitLogResponse> {
    const repo = this.repoWorkdir(req.path);
    const fmt = `%H${US}%h${US}%P${US}%an${US}%ae${US}%at${US}%cn${US}%ce${US}%ct${US}%s${US}%b${RS}`;
    const pathspec = req.pathspec.length ? ` -- ${req.pathspec.map(shellQuote).join(" ")}` : "";
    const { stdout, exitCode } = await this.run({
      cmd: `git log --format=${shellQuote(fmt)} -n${req.maxCount + 1} --skip=${req.skip} ${shellQuote(req.ref)}${pathspec}`,
      workdir: repo,
    });
    if (exitCode !== null && exitCode !== 0) {
      return { commits: [], hasMore: false };
    }
    const records = stdout
      .split(RS)
      .map((r) => r.replace(/^\n/, ""))
      .filter((r) => r.trim().length > 0);
    const commits: GitCommit[] = [];
    for (const rec of records.slice(0, req.maxCount)) {
      const f = rec.split(US);
      if (f.length < 11) continue;
      commits.push({
        sha: f[0]!,
        shortSha: f[1]!,
        parents: (f[2] ?? "").trim() ? f[2]!.trim().split(" ") : [],
        author: { name: f[3]!, email: f[4]!, timestamp: safeInt(f[5]) ?? 0 },
        committer: { name: f[6]!, email: f[7]!, timestamp: safeInt(f[8]) ?? 0 },
        subject: f[9]!,
        body: f.slice(10).join(US),
        refs: [],
      });
    }
    return { commits, hasMore: records.length > req.maxCount };
  }

  async gitShow(req: GitShowRequest): Promise<GitShowResponse> {
    const repo = this.repoWorkdir(req.path);
    if (req.filePath) {
      // Raw blob mode: ref:filePath -> bytes.
      const { stdout, exitCode } = await this.run({
        cmd: `git cat-file blob ${shellQuote(`${req.ref}:${req.filePath}`)} 2>/dev/null | base64`,
        workdir: repo,
      });
      if (exitCode !== null && exitCode !== 0 && stdout.trim() === "") {
        throw new ChannelANotFoundError(`blob not found: ${req.ref}:${req.filePath}`);
      }
      const bytes = Buffer.from(stdout.replace(/\n/g, ""), "base64");
      const truncated = bytes.byteLength > req.maxBytesPerFile;
      const clamped = truncated ? bytes.subarray(0, req.maxBytesPerFile) : bytes;
      const isBinary = sniffBinary(clamped);
      const encoding = req.encoding === "base64" || isBinary ? "base64" : "utf8";
      return {
        commit: null,
        files: [],
        blob: {
          content: encoding === "base64" ? clamped.toString("base64") : clamped.toString("utf8"),
          encoding,
          sizeBytes: clamped.byteLength,
          truncated,
        },
        revision: this.revision,
      };
    }
    // Commit mode: metadata + diff vs first parent.
    const log = await this.gitLog({
      path: req.path,
      ref: req.ref,
      maxCount: 1,
      skip: 0,
      pathspec: [],
    });
    const commit = log.commits[0] ?? null;
    const diff = await this.gitDiff({
      path: req.path,
      staged: false,
      fromRef: `${req.ref}^`,
      toRef: req.ref,
      pathspec: [],
      contextLines: 3,
      maxBytesPerFile: req.maxBytesPerFile,
    });
    return { commit, files: diff.files, blob: null, revision: this.revision };
  }

  /**
   * Detect repo roots within every supported workspace layout.
   *
   * The platform seeds GitHub repositories at
   * `repos/<owner>/<repo>`, which puts the `.git` marker at depth four from the
   * workspace root. Do not reintroduce a fixed maxdepth here. Traversal is
   * bounded instead by pruning known machine/build residue, a wall-clock
   * timeout, and a result limit. `.git` may be either a directory (ordinary
   * clone/submodule) or a file (linked worktree).
   *
   * Callers that persist an authoritative snapshot must use this detailed
   * result and surface an incomplete discovery. The compact `detectRepos()`
   * wrapper remains for capability negotiation, where the best available list
   * is preferable to failing the whole capabilities document.
   */
  async detectReposDetailed(): Promise<RepositoryDiscoveryResult> {
    try {
      const discovery = [
        "find . -xdev",
        "\\( -name .git \\( -type d -o -type f \\) -print -prune \\)",
        "-o \\( -type d \\( -name node_modules -o -name .cache -o -name .local",
        "-o -name dist -o -name build -o -name target -o -name .venv",
        "-o -name __pycache__ -o -name .next \\) -prune \\)",
        "2>/dev/null",
      ].join(" ");
      // The status trailer is necessary for providers whose only structural
      // surface is `execCommand`: that fallback has stdout but no numeric exit
      // code. Without the trailer a timed-out discovery could look like a
      // successful authoritative zero-repo result.
      //
      // Do not use GNU `timeout` here. Connected Machines include macOS, whose
      // stock userland does not provide it. The watchdog kills `find` directly
      // after the wall-clock budget and records whether that kill won the race.
      // Its stdio is detached so cancelling a fast discovery cannot leave the
      // watchdog's `sleep` holding the provider output pipe open.
      const command = [
        'results_file=$(mktemp "${TMPDIR:-/tmp}/opengeni-repository-discovery.XXXXXX") || exit 70',
        'timeout_file="${results_file}.timed-out"',
        "discovery_pid=",
        "watchdog_pid=",
        'cleanup() { if [ -n "$discovery_pid" ]; then kill "$discovery_pid" 2>/dev/null || true; fi; if [ -n "$watchdog_pid" ]; then kill "$watchdog_pid" 2>/dev/null || true; fi; rm -f "$results_file" "$timeout_file"; }',
        "abort() { trap - EXIT; cleanup; exit 143; }",
        "trap cleanup EXIT",
        "trap abort HUP INT TERM",
        `${discovery} > "$results_file" &`,
        "discovery_pid=$!",
        '(sleeper_pid=; stop_watchdog() { if [ -n "$sleeper_pid" ]; then kill "$sleeper_pid" 2>/dev/null || true; wait "$sleeper_pid" 2>/dev/null || true; fi; exit 0; }; trap stop_watchdog HUP INT TERM; sleep 15 & sleeper_pid=$!; wait "$sleeper_pid"; sleeper_pid=; if kill -TERM "$discovery_pid" 2>/dev/null; then : > "$timeout_file"; fi) </dev/null >/dev/null 2>&1 &',
        "watchdog_pid=$!",
        'wait "$discovery_pid"',
        "status=$?",
        "discovery_pid=",
        'kill "$watchdog_pid" 2>/dev/null || true',
        'wait "$watchdog_pid" 2>/dev/null || true',
        "watchdog_pid=",
        'if [ "$status" -ne 0 ] && [ -f "$timeout_file" ]; then status=124; fi',
        `if [ "$status" -eq 0 ]; then awk 'NR <= ${REPOSITORY_DISCOVERY_LIMIT} { print } NR == ${
          REPOSITORY_DISCOVERY_LIMIT + 1
        } { print "${REPOSITORY_DISCOVERY_TRUNCATED_SENTINEL}" }' "$results_file"; fi`,
        `printf '\\n${REPOSITORY_DISCOVERY_STATUS_PREFIX}%s\\n' "$status"`,
        'exit "$status"',
      ].join("\n");
      const { stdout } = await this.run({
        cmd: `bash -lc ${shellQuote(command)}`,
        workdir: this.workspaceRoot || undefined,
        yieldTimeMs: 20_000,
        // At most 256 Unix paths (PATH_MAX each) plus the status trailer. This
        // prevents a provider's ordinary output cap from dropping the trailer
        // and making a partial list look complete.
        maxOutputTokens: 300_000,
      });
      const statusLine = stdout
        .split("\n")
        .find((line) => line.startsWith(REPOSITORY_DISCOVERY_STATUS_PREFIX));
      const embeddedStatus = statusLine
        ? Number.parseInt(statusLine.slice(REPOSITORY_DISCOVERY_STATUS_PREFIX.length), 10)
        : null;
      // The command always prints this trailer after discovery settles. Missing
      // means provider-side output truncation or an outer-shell failure, neither
      // of which is authoritative discovery even if exec reports exit 0.
      const status = Number.isInteger(embeddedStatus) ? embeddedStatus : null;
      if (status === 124) {
        return { repos: [], complete: false, degradedReason: "command_timed_out" };
      }
      if (status !== 0) {
        return { repos: [], complete: false, degradedReason: "command_failed" };
      }
      const lines = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((line) => Boolean(line) && !line.startsWith(REPOSITORY_DISCOVERY_STATUS_PREFIX));
      const truncated = lines.includes(REPOSITORY_DISCOVERY_TRUNCATED_SENTINEL);
      const repos = [
        ...new Set(
          lines
            .filter((line) => line !== REPOSITORY_DISCOVERY_TRUNCATED_SENTINEL)
            .map((gitMarker) => dirnameAbs(stripDotSlash(gitMarker, "")) || ""),
        ),
      ].sort();
      return {
        repos,
        complete: !truncated,
        degradedReason: truncated ? "result_limit_exceeded" : null,
      };
    } catch {
      return { repos: [], complete: false, degradedReason: "command_failed" };
    }
  }

  /** Detect repo roots within the workspace (for the Git.repos capability). */
  async detectRepos(): Promise<string[]> {
    return (await this.detectReposDetailed()).repos;
  }

  // ════════════════════════ Terminal exec + PTY (A2) ════════════════════════

  /** Run a bounded command, return buffered stdout/stderr + exit code inline. The
   *  long-running tail (when the process hasn't exited within timeoutMs) keeps
   *  running in-box; if emitStream is set the buffered output is also published as
   *  the agent firehose so other viewers see it. */
  async terminalExec(req: TerminalExecRequest): Promise<TerminalExecResponse> {
    const r = await this.run({
      cmd: req.command,
      workdir: this.terminalWorkdir(req.cwd),
      yieldTimeMs: req.timeoutMs,
    });
    const running = r.exitCode === null && typeof r.sessionId === "number";
    if (req.emitStream && (r.stdout || r.stderr)) {
      const events: { type: SessionEventType; payload: unknown }[] = [];
      const commandId = crypto.randomUUID();
      if (r.stdout)
        events.push({
          type: "sandbox.command.output.delta",
          payload: { stream: "stdout", chunk: r.stdout, commandId, seq: 0 },
        });
      if (r.stderr)
        events.push({
          type: "sandbox.command.output.delta",
          payload: { stream: "stderr", chunk: r.stderr, commandId, seq: 1 },
        });
      await this.emitEvents(events);
    }
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      running,
      wallTimeSeconds: r.wallTimeSeconds,
    };
  }

  /** Open an interactive PTY: exec the shell with tty:true, yielding the numeric
   *  exec-session id the caller persists (ptyId<->execSessionId) so subsequent
   *  writeStdin can drive it. Returns the supportsInput gate (false when the
   *  backend has no writeStdin). The caller emits terminal.pty.started after it
   *  persists the row. */
  async ptyOpen(
    req: PtyOpenRequest,
    ptyId: string,
  ): Promise<{
    response: PtyOpenResponse;
    execSessionId: number | null;
    shell: string;
    initialOutput: string;
  }> {
    const supportsInput = Boolean(this.session.supportsPty?.() && this.session.writeStdin);
    const shell = req.shell ?? "/bin/bash";
    const r = await this.run({
      cmd: shell,
      workdir: this.terminalWorkdir(req.cwd),
      tty: true,
      login: true,
      yieldTimeMs: 250,
    });
    return {
      response: { ptyId, streamVia: "sse-events", supportsInput },
      execSessionId: typeof r.sessionId === "number" ? r.sessionId : null,
      shell,
      initialOutput: r.stdout,
    };
  }

  /** Drive an open PTY's stdin. Returns the drained output (the caller publishes
   *  it as terminal.pty.output.delta). Throws ChannelAUnsupportedError when the
   *  backend has no writeStdin. */
  async ptyWrite(_req: PtyWriteRequest, execSessionId: number, data: string): Promise<string> {
    if (!this.session.writeStdin) {
      throw new ChannelAUnsupportedError("interactive terminal unsupported on this backend");
    }
    const out = await this.session.writeStdin({
      sessionId: execSessionId,
      chars: data,
      yieldTimeMs: 250,
    });
    // The Modal exec surface reports a vanished exec-session as a NON-throwing
    // string ("write_stdin failed: session not found: N") that we used to stream
    // verbatim into the terminal. That happens when the persisted exec-session no
    // longer exists on the live box — historically the box-mismatch (resume_state
    // pointing at a rival box; fixed at the lease layer), or a genuine box
    // rollover after the PTY opened. Surface it as a typed CONFLICT so the route
    // returns 409 and the client cleanly RE-OPENS the PTY against the live box,
    // instead of writing a raw "session not found: 1" into the user's xterm.
    if (isExecSessionLostBanner(out, execSessionId)) {
      throw new ChannelAConflictError("pty session lost on the live box; reopen the terminal");
    }
    return stripExecBanner(out);
  }

  /** Resize an open PTY (SIGWINCH via stty against the exec-session). The SDK has
   *  no resize method; stty in the same tty session updates the geometry. */
  async ptyResize(req: PtyResizeRequest, execSessionId: number): Promise<void> {
    if (!this.session.writeStdin) return;
    // Send a stty in-band on the same pty session.
    await this.session.writeStdin({
      sessionId: execSessionId,
      chars: `stty cols ${req.cols} rows ${req.rows}\n`,
      yieldTimeMs: 50,
    });
  }

  /** Close an open PTY: write exit/EOF. The caller marks the row closed + emits
   *  terminal.pty.exited. */
  async ptyClose(_req: PtyCloseRequest, execSessionId: number | null): Promise<void> {
    if (execSessionId !== null && this.session.writeStdin) {
      try {
        await this.session.writeStdin({ sessionId: execSessionId, chars: "", yieldTimeMs: 50 }); // EOF
      } catch {
        // best-effort; the row is marked closed regardless.
      }
    }
  }

  // ──────────────────────────── helpers ──────────────────────────────────────

  /** The current FS revision (for the caller to persist/seed). */
  currentRevision(): number {
    return this.revision;
  }

  private joinRoot(rel: string): string {
    if (!this.workspaceRoot) return rel === "" ? "." : rel;
    return rel === "" ? this.workspaceRoot : `${this.workspaceRoot}/${rel}`;
  }

  private repoWorkdir(rel: string): string | undefined {
    const safe = normalizeRelPath(rel);
    const joined = this.joinRoot(safe);
    return joined === "." ? this.workspaceRoot || undefined : joined;
  }

  private terminalWorkdir(cwd: string): string | undefined {
    // Model-facing terminal tools may send the manifest-rooted virtual frame.
    // Preserve it for sessions like selfhosted whose own adapter maps it onto
    // the real machine working dir; repo-relative dock fs/git still use repoWorkdir.
    if (cwd === SELFHOSTED_VIRTUAL_ROOT || cwd.startsWith(`${SELFHOSTED_VIRTUAL_ROOT}/`)) {
      return cwd;
    }
    return this.repoWorkdir(cwd);
  }

  private async emitEvents(events: { type: SessionEventType; payload: unknown }[]): Promise<void> {
    if (!this.emit || events.length === 0) return;
    try {
      await this.emit(events);
    } catch {
      /* durable spine retries; not fatal */
    }
  }

  private async emitFsChanged(
    changes: FsChangedPayload["changes"],
    source: FsChangedPayload["source"],
  ): Promise<void> {
    const payload: FsChangedPayload = {
      changes,
      source,
      revision: this.revision,
      leaseEpoch: this.leaseEpoch,
    };
    await this.emitEvents([{ type: "fs.changed", payload }]);
  }

  /** Re-probe git after a mutation and emit git.changed (best-effort, used by the
   *  worker agent-turn side after FS-mutating tools). */
  async emitGitChanged(repoPath: string, reason: GitChangedPayload["reason"]): Promise<void> {
    try {
      const status = await this.gitStatus({ path: repoPath });
      const payload: GitChangedPayload = {
        head: status.head,
        dirty: status.files.length > 0,
        ahead: status.ahead,
        behind: status.behind,
        changedFileCount: status.files.length,
        reason,
        revision: this.revision,
        leaseEpoch: this.leaseEpoch,
      };
      await this.emitEvents([{ type: "git.changed", payload }]);
    } catch {
      // non-repo / git absent — no notification.
    }
  }
}

// ════════════════════════════ pure parsers/helpers ══════════════════════════

// Strip the formatExecResponse banner (Chunk ID / Wall time / Process … / Output:)
// — only used when exec() is absent and we fall back to execCommand's string.
export function stripExecBanner(raw: string): string {
  const marker = raw.indexOf("\nOutput:\n");
  if (marker >= 0) return raw.slice(marker + "\nOutput:\n".length);
  if (raw.startsWith("Output:\n")) return raw.slice("Output:\n".length);
  return raw;
}

// Detect the provider's native-readFile workspace-escape rejection — a symlink
// whose target resolves outside the sandbox root. Modal phrases it "Sandbox path
// failed remote validation: workspace escape: <target>"; we match loosely so a
// wording tweak still classifies it. Used to fall the read back onto the exec
// path (which follows the link and isn't path-validated) instead of 404-ing.
export function isWorkspaceEscapeError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  const lower = msg.toLowerCase();
  return (
    lower.includes("workspace escape") ||
    (lower.includes("remote validation") && lower.includes("escape"))
  );
}

// Detect the Modal "the exec-session you're writing to no longer exists" banner.
// writeStdin reports a vanished session as a non-throwing string of the shape
// `write_stdin failed: session not found: <N>` (it does NOT raise). We treat that
// as a lost PTY (the box rolled over / was re-created since the open) so the
// caller surfaces a clean reconnect instead of writing the raw failure into
// xterm. Matched loosely (`session not found`) with the id when present so a
// future wording tweak still classifies it; the command's own output cannot spoof
// it because the SDK emits this as the whole writeStdin return, not user output.
export function isExecSessionLostBanner(out: string, execSessionId: number): boolean {
  if (!out) return false;
  const lower = out.toLowerCase();
  if (!lower.includes("session not found")) return false;
  // When the id is present require it to match ours; when absent, the generic
  // "session not found" still classifies (it is never legitimate stdout here).
  return (
    lower.includes(`session not found: ${execSessionId}`) || !/session not found:\s*\d+/.test(lower)
  );
}

// Recover the numeric exec-session id the SDK embeds in a formatExecResponse
// banner for a STILL-RUNNING process (`Process running with session ID <N>`).
// A finished command emits `Process exited with code <N>` instead (no session
// id) — that yields null. Only the banner region (before the `Output:` marker)
// is scanned so a session-id-looking line in the command's own output can't
// spoof it. This is what makes the interactive PTY work on backends whose only
// exec surface is execCommand (Modal): without it ptyOpen reports execSessionId
// = null and every pty/write 409s ("interactive terminal unsupported").
export function parseExecBannerSessionId(raw: string): number | null {
  const outputIdx = raw.indexOf("\nOutput:\n");
  const banner = outputIdx >= 0 ? raw.slice(0, outputIdx) : raw.startsWith("Output:\n") ? "" : raw;
  const match = banner.match(/Process running with session ID (\d+)/);
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

function sniffBinary(bytes: Buffer): boolean {
  const n = Math.min(bytes.byteLength, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

function normalizeRelPath(p: string): string {
  const trimmed = (p ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed;
}

// Reject path traversal / absolute paths (case 4); the box normalizes against
// the workspace root, so a leading slash or `..` is a 400.
export function assertSafeRelPath(p: string): string {
  const norm = normalizeRelPath(p);
  if (norm === "") throw new ChannelAValidationError("path is required");
  if (p.startsWith("/")) throw new ChannelAValidationError(`absolute paths are not allowed: ${p}`);
  if (norm.split("/").some((seg) => seg === ".."))
    throw new ChannelAValidationError(`path traversal is not allowed: ${p}`);
  return norm;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : "";
}

function dirnameAbs(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx > 0 ? p.slice(0, idx) : "";
}

function dirnameRel(p: string, root: string): string {
  const idx = p.lastIndexOf("/");
  if (idx < 0) return root;
  return p.slice(0, idx);
}

function stripDotSlash(rawPath: string, root: string): string {
  let p = rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
  p = p.replace(/^\/+/, "");
  // find run with workdir=root and findRoot="." gives paths relative to root,
  // but if root is non-empty the relPath should still be workspace-relative.
  if (root && !p.startsWith(`${root}/`) && p !== root) {
    return root ? `${root}/${p}` : p;
  }
  return p;
}

function findTypeToNode(t: string): FsTreeNode["type"] {
  if (t === "d") return "dir";
  if (t === "f") return "file";
  if (t === "l") return "symlink";
  return "other";
}

function safeInt(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function safeOctal(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number.parseInt(s, 8);
  return Number.isFinite(n) ? n : null;
}

function mtimeToMs(s: string | undefined): number | null {
  if (s === undefined) return null;
  const f = Number.parseFloat(s);
  return Number.isFinite(f) ? Math.round(f * 1000) : null;
}

function sortTree(node: FsTreeNode): void {
  if (!node.children) return;
  node.children.sort((a, b) => {
    if (a.type === "dir" && b.type !== "dir") return -1;
    if (a.type !== "dir" && b.type === "dir") return 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) sortTree(child);
}

function isImagePath(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|ico|svg|tiff?)$/i.test(p);
}

// ── git status --porcelain=v2 --branch -z parser ────────────────────────────
export function parsePorcelainV2(z: string): Omit<GitStatusResponse, "revision"> {
  const records = z.split(NUL);
  let head: string | null = null;
  let upstream: string | null = null;
  let detached = false;
  let ahead = 0;
  let behind = 0;
  const files: GitFileStatus[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec === "") continue;
    if (rec.startsWith("# branch.head ")) {
      const v = rec.slice("# branch.head ".length);
      if (v === "(detached)") {
        detached = true;
        head = null;
      } else head = v;
    } else if (rec.startsWith("# branch.upstream ")) {
      upstream = rec.slice("# branch.upstream ".length);
    } else if (rec.startsWith("# branch.ab ")) {
      const m = rec.slice("# branch.ab ".length).match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (rec.startsWith("1 ")) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const fields = rec.split(" ");
      const xy = fields[1] ?? "..";
      const path = fields.slice(8).join(" ");
      files.push(statusFromXY(xy, path, null));
    } else if (rec.startsWith("2 ")) {
      // 2 <XY> ... <Xscore> <path>\0<origPath>  — the origPath is the NEXT NUL rec
      const fields = rec.split(" ");
      const xy = fields[1] ?? "..";
      const path = fields.slice(9).join(" ");
      const oldPath = records[i + 1] ?? null;
      i++; // consume the origPath record
      files.push(statusFromXY(xy, path, oldPath));
    } else if (rec.startsWith("u ")) {
      const fields = rec.split(" ");
      const path = fields.slice(10).join(" ");
      files.push({
        path,
        oldPath: null,
        index: "conflicted",
        worktree: "conflicted",
        isConflicted: true,
      });
    } else if (rec.startsWith("? ")) {
      files.push({
        path: rec.slice(2),
        oldPath: null,
        index: null,
        worktree: "untracked",
        isConflicted: false,
      });
    } else if (rec.startsWith("! ")) {
      files.push({
        path: rec.slice(2),
        oldPath: null,
        index: null,
        worktree: "ignored",
        isConflicted: false,
      });
    }
  }
  return { isRepo: true, head, detached, upstream, ahead, behind, files };
}

function xyCode(c: string): GitFileStatusCode | null {
  switch (c) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typechange";
    case "U":
      return "conflicted";
    case ".":
      return null;
    default:
      return null;
  }
}

function statusFromXY(xy: string, path: string, oldPath: string | null): GitFileStatus {
  const x = xy[0] ?? ".";
  const y = xy[1] ?? ".";
  return {
    path,
    oldPath,
    index: xyCode(x),
    worktree: xyCode(y),
    isConflicted: x === "U" || y === "U",
  };
}

// ── numstat -z parser (additions/deletions/binary + rename old\0new) ─────────
export type NumstatEntry = {
  additions: number;
  deletions: number;
  binary: boolean;
  oldPath: string | null;
  newPath: string;
};
export function parseNumstatZ(z: string): NumstatEntry[] {
  const fields = z.split(NUL);
  const out: NumstatEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const head = fields[i]!;
    if (head === "") {
      i++;
      continue;
    }
    // "<add>\t<del>\t<path>" OR for a rename "<add>\t<del>\t" then old\0new follow.
    const m = head.match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!m) {
      i++;
      continue;
    }
    const addStr = m[1]!;
    const delStr = m[2]!;
    const pathPart = m[3]!;
    const binary = addStr === "-" && delStr === "-";
    if (pathPart === "") {
      // rename: the next two NUL fields are old, new
      const oldPath = fields[i + 1] ?? null;
      const newPath = fields[i + 2] ?? "";
      out.push({
        additions: binary ? 0 : Number(addStr),
        deletions: binary ? 0 : Number(delStr),
        binary,
        oldPath,
        newPath,
      });
      i += 3;
    } else {
      out.push({
        additions: binary ? 0 : Number(addStr),
        deletions: binary ? 0 : Number(delStr),
        binary,
        oldPath: null,
        newPath: pathPart,
      });
      i++;
    }
  }
  return out;
}

// ── unified-diff parser -> GitDiffHunk[] (the Pierre-diff shape) ─────────────
export function parseUnifiedPatch(patch: string): {
  hunks: GitDiffHunk[];
  status: GitFileStatusCode;
} {
  const lines = patch.split("\n");
  const hunks: GitDiffHunk[] = [];
  let status: GitFileStatusCode = "modified";
  let current: GitDiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of lines) {
    if (line.startsWith("new file mode")) status = "added";
    else if (line.startsWith("deleted file mode")) status = "deleted";
    else if (line.startsWith("rename from") || line.startsWith("rename to")) status = "renamed";
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      if (m) {
        const oldStart = Number(m[1]);
        const oldLines = m[2] !== undefined ? Number(m[2]) : 1;
        const newStart = Number(m[3]);
        const newLines = m[4] !== undefined ? Number(m[4]) : 1;
        current = {
          oldStart,
          oldLines,
          newStart,
          newLines,
          header: (m[5] ?? "").trim(),
          lines: [],
        };
        hunks.push(current);
        oldNo = oldStart;
        newNo = newStart;
      }
      continue;
    }
    if (!current) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const marker = line[0];
    const text = line.slice(1);
    if (marker === "+") {
      current.lines.push({ type: "add", oldNo: null, newNo, text });
      newNo++;
    } else if (marker === "-") {
      current.lines.push({ type: "del", oldNo, newNo: null, text });
      oldNo++;
    } else if (marker === " ") {
      current.lines.push({ type: "context", oldNo, newNo, text });
      oldNo++;
      newNo++;
    }
  }
  return { hunks, status };
}
