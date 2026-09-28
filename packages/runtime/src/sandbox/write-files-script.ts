// Shell program behind SandboxChannelAService.fsWriteFiles. One provider
// command verifies a directory tree and creates every missing file in it, so a
// multi-file write costs one round trip (and, on routed sessions, one durable
// mutation admission) instead of several per file. The program never replaces
// an existing path: an existing regular file with the same bytes is reported
// unchanged, and anything else fails the whole command before it writes.

/** Longest generated command. Linux caps one argv string at 128 KiB and the
 * provider passes the command as one argument; this stays at the size the
 * single-file inline write path already sends. */
export const WRITE_FILES_COMMAND_MAX_CHARS = 88 * 1024;

export type WriteFilesScriptDirectory = Readonly<{
  /** Index into the request's directory list; reported in markers. */
  index: number;
  providerPath: string;
}>;

export type WriteFilesScriptFile = Readonly<{
  /** Index into the request's file list; reported in markers. */
  index: number;
  providerPath: string;
  sizeBytes: number;
  sha256: string;
  /** Present only in write mode. */
  base64?: string;
}>;

export type WriteFilesFailureCode =
  | "CONFLICT"
  | "UNVERIFIED"
  | "SYMLINK"
  | "NOT_DIR"
  | "NOT_FOUND"
  | "ESCAPE"
  | "WRITE_FAILED";

export type WriteFilesOutput = {
  complete: boolean;
  /** Existing files with the expected bytes. */
  same: number[];
  /** Missing files (check mode only). */
  missing: number[];
  written: number[];
  createdDirectories: number[];
  failure: {
    code: WriteFilesFailureCode;
    target: { kind: "directory" | "file"; index: number } | null;
  } | null;
};

const BATCH_OK = "__OPENGENI_FS_BATCH_OK__";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Characters one fragment adds to the final quoted `bash -c` command. */
export function quotedLength(fragment: string): number {
  let quotes = 0;
  for (const character of fragment) if (character === "'") quotes += 1;
  // Each quote becomes '\'' inside the outer single-quoted script, plus a newline.
  return fragment.length + quotes * 3 + 1;
}

export function writeFilesPrelude(input: {
  root: string;
  realpathFunction: string;
  sha256Function: string;
}): string[] {
  return [
    "set -u",
    input.realpathFunction,
    input.sha256Function,
    `og_fail() { printf '%s' "$1"; exit "$2"; }`,
    `root=$(opengeni_realpath_existing ${shellQuote(input.root)}) || og_fail __OPENGENI_FS_NOT_FOUND__ 66`,
    `og_confined() { case "$1" in "$root"|"\${root%/}/"*) return 0 ;; *) return 1 ;; esac; }`,
    // A directory on the path is never a symbolic link and always resolves
    // beneath the workspace root. A missing one returns 1 for the caller.
    [
      "og_dir() {",
      `[ ! -L "$2" ] || og_fail "__OPENGENI_FS_SYMLINK__D$1__" 68`,
      `[ -e "$2" ] || return 1`,
      `[ -d "$2" ] || og_fail "__OPENGENI_FS_NOT_DIR__D$1__" 69`,
      `og_t=$(opengeni_realpath_existing "$2") || og_fail "__OPENGENI_FS_NOT_FOUND__D$1__" 66`,
      `og_confined "$og_t" || og_fail "__OPENGENI_FS_ESCAPE__D$1__" 67`,
      "}",
    ].join("\n"),
    // 0: the exact bytes already exist. 1: missing. Anything else fails.
    [
      "og_file() {",
      `if [ -L "$2" ]; then og_fail "__OPENGENI_FS_CONFLICT__F$1__" 65; fi`,
      `[ -e "$2" ] || return 1`,
      `[ -f "$2" ] || og_fail "__OPENGENI_FS_CONFLICT__F$1__" 65`,
      `og_n=$(wc -c < "$2") || og_fail "__OPENGENI_FS_CONFLICT__F$1__" 65`,
      `[ "$((og_n))" = "$3" ] || og_fail "__OPENGENI_FS_CONFLICT__F$1__" 65`,
      `og_h=$(opengeni_sha256_file "$2") || og_fail "__OPENGENI_FS_UNVERIFIED__F$1__" 65`,
      `[ "$og_h" = "$4" ] || og_fail "__OPENGENI_FS_CONFLICT__F$1__" 65`,
      "}",
    ].join("\n"),
    [
      "og_mk() {",
      `mkdir -- "$2" 2>/dev/null || og_fail "__OPENGENI_FS_WRITE_FAILED__D$1__" 70`,
      `printf '__OGF_D__%s__' "$1"`,
      `og_dir "$1" "$2" || og_fail "__OPENGENI_FS_NOT_FOUND__D$1__" 66`,
      "}",
    ].join("\n"),
    // noclobber opens a missing path with O_EXCL, so a file that appeared
    // since the check (including a dangling symlink) is never replaced.
    [
      "og_put() {",
      `( set -C; printf '%s' "$4" | base64 -d > "$2" ) 2>/dev/null || og_fail "__OPENGENI_FS_WRITE_FAILED__F$1__" 71`,
      `og_n=$(wc -c < "$2") || og_fail "__OPENGENI_FS_WRITE_FAILED__F$1__" 71`,
      `[ "$((og_n))" = "$3" ] || og_fail "__OPENGENI_FS_WRITE_FAILED__F$1__" 71`,
      `printf '__OGF_W__%s__' "$1"`,
      "}",
    ].join("\n"),
  ];
}

export function directoryCheckFragment(directory: WriteFilesScriptDirectory): string {
  return `og_dir ${directory.index} ${shellQuote(directory.providerPath)} || :`;
}

export function fileCheckFragment(file: WriteFilesScriptFile, mode: "check" | "write"): string {
  const check = `og_file ${file.index} ${shellQuote(file.providerPath)} ${file.sizeBytes} ${file.sha256}`;
  const missing = mode === "check" ? `printf '__OGF_M__%s__' ${file.index}` : `og_m${file.index}=1`;
  return `if ${check}; then printf '__OGF_S__%s__' ${file.index}; else ${missing}; fi`;
}

export function directoryCreateFragment(directory: WriteFilesScriptDirectory): string {
  const path = shellQuote(directory.providerPath);
  return `og_dir ${directory.index} ${path} || og_mk ${directory.index} ${path}`;
}

export function filePutFragment(file: WriteFilesScriptFile): string {
  if (file.base64 === undefined) throw new Error("write mode requires file content");
  return `[ -z "\${og_m${file.index}:-}" ] || og_put ${file.index} ${shellQuote(file.providerPath)} ${file.sizeBytes} ${shellQuote(file.base64)}`;
}

/**
 * Check mode is read-only and reports each file as same or missing. Write mode
 * checks every directory and file first, then creates missing directories
 * (shallowest first) and missing files. Directories must be ordered so every
 * parent precedes its children.
 */
export function writeFilesScript(input: {
  prelude: readonly string[];
  mode: "check" | "write";
  directories: readonly WriteFilesScriptDirectory[];
  files: readonly WriteFilesScriptFile[];
}): string {
  const lines = [...input.prelude];
  for (const directory of input.directories) lines.push(directoryCheckFragment(directory));
  for (const file of input.files) lines.push(fileCheckFragment(file, input.mode));
  if (input.mode === "write") {
    for (const directory of input.directories) lines.push(directoryCreateFragment(directory));
    for (const file of input.files) lines.push(filePutFragment(file));
  }
  lines.push(`printf '%s' ${BATCH_OK}`);
  return lines.join("\n");
}

/** Markers carry no newlines, so providers that drop newline bytes still parse. */
export function parseWriteFilesOutput(stdout: string): WriteFilesOutput {
  const output: WriteFilesOutput = {
    complete: stdout.includes(BATCH_OK),
    same: [],
    missing: [],
    written: [],
    createdDirectories: [],
    failure: null,
  };
  for (const match of stdout.matchAll(/__OGF_([SMWD])__(\d+)__/g)) {
    const index = Number(match[2]);
    if (match[1] === "S") output.same.push(index);
    else if (match[1] === "M") output.missing.push(index);
    else if (match[1] === "W") output.written.push(index);
    else output.createdDirectories.push(index);
  }
  const failure =
    /__OPENGENI_FS_(CONFLICT|UNVERIFIED|SYMLINK|NOT_DIR|NOT_FOUND|ESCAPE|WRITE_FAILED)__(?:([DF])(\d+)__)?/.exec(
      stdout,
    );
  if (failure) {
    output.failure = {
      code: failure[1] as WriteFilesFailureCode,
      target: failure[2]
        ? { kind: failure[2] === "D" ? "directory" : "file", index: Number(failure[3]) }
        : null,
    };
  }
  return output;
}
