import { createHash } from "node:crypto";

const PAYLOAD = 192;
const MAX_RECORD = 512;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The native session service normalizes lines and does not escape stream
 * markers. Encode bytes before that producer, using bounded ASCII records.
 * Bash and coreutils are existing Debian/native execution prerequisites (the
 * native Process env compiler already uses base64); Python is not involved. */
export function daytonaCommandFrames(
  original: string,
  nonce: string,
  cwd?: string,
  env: Record<string, string> = {},
) {
  if (!/^[a-f0-9-]{36}$/u.test(nonce) || original.includes("\0"))
    throw new Error("Invalid native command frame identity or source");
  for (const key of Object.keys(env))
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
      throw new Error("Invalid native command environment key");
  const source = [
    ...(cwd ? [`cd -- ${quote(cwd)} || exit 125`] : []),
    ...Object.entries(env).map(
      ([key, value]) =>
        `export ${key}="$(printf '%s' ${quote(Buffer.from(value).toString("base64"))} | /usr/bin/base64 -d)"`,
    ),
    original,
  ].join("\n");
  const commandSha256 = digest(Buffer.from(source));
  let delimiter = `__FS_SOURCE_${nonce.replaceAll("-", "_")}__`;
  while (source.includes(delimiter)) delimiter += "_";
  const sentinel = `${delimiter}_END`;
  const header = `OGF1 ${nonce} ${commandSha256}`;
  const script = [
    "set -o pipefail",
    "IFS= read -r -d '' __fs_source <<'" + delimiter + "' || :",
    source + sentinel,
    delimiter,
    `__fs_source="\${__fs_source%${sentinel}$'\\n'}"`,
    '__fs_hash="$(printf \'%s\' "$__fs_source" | /usr/bin/sha256sum)" || exit 125',
    `[ "\${__fs_hash%% *}" = '${commandSha256}' ] || exit 125`,
    "__fs_encode() {",
    '  local name="$1" encoded checksum block sequence=0 bytes=0 size',
    '  encoded="$(/usr/bin/base64 -w0)" || return 125',
    '  checksum="$(printf \'%s\' "$encoded" | /usr/bin/base64 -d | /usr/bin/sha256sum)" || return 125',
    '  checksum="${checksum%% *}"',
    '  while IFS= read -r block || [ -n "$block" ]; do',
    "    size=$(( ${#block} / 4 * 3 ))",
    '    case "$block" in *==) size=$((size - 2)) ;; *=) size=$((size - 1)) ;; esac',
    `    printf '${header} DATA %s %s %s %s\\n' "$name" "$sequence" "$size" "$block" || return 125`,
    "    bytes=$((bytes + size)); sequence=$((sequence + 1))",
    `  done < <(printf '%s' "$encoded" | /usr/bin/fold -w${PAYLOAD})`,
    `  printf '${header} EOF %s %s %s %s\\n' "$name" "$sequence" "$bytes" "$checksum"`,
    "}",
    `printf '${header} START\\n' || exit 125`,
    "exec 3> >(__fs_encode stdout)",
    "__fs_out=$!",
    "exec 4> >(__fs_encode stderr >&2)",
    "__fs_err=$!",
    "(",
    "  exec 1>&3 2>&4 3>&- 4>&-",
    '  exec /bin/sh -c "$__fs_source"',
    ") < /dev/null &",
    "__fs_child=$!",
    "exec 3>&- 4>&-",
    'wait "$__fs_child"; __fs_status=$?',
    'wait "$__fs_out" || exit 125',
    'wait "$__fs_err" || exit 125',
    `printf '${header} EXIT %s\\n' "$__fs_status" || exit 125`,
    'exit "$__fs_status"',
  ].join("\n");
  let outer = `${delimiter}_SCRIPT`;
  while (script.split("\n").includes(outer)) outer += "_";
  return {
    command: `/bin/bash --noprofile --norc <<'${outer}'\n${script}\n${outer}`,
    nonce,
    commandSha256,
    decode(raw: string, physicalExit: number | null) {
      const streams = {
        stdout: { chunks: [] as Buffer[], sequence: 0, bytes: 0, eof: false },
        stderr: { chunks: [] as Buffer[], sequence: 0, bytes: 0, eof: false },
      };
      let begun = false;
      let exit: number | null = null;
      const lines = raw.split("\n");
      const incomplete = lines.pop()!;
      if (incomplete.length > MAX_RECORD || /[^\x01\x02\x20-\x7e]/u.test(incomplete))
        throw new Error("Invalid incomplete native command record");
      const integer = (text: string) => {
        if (!/^(0|[1-9][0-9]*)$/u.test(text) || !Number.isSafeInteger(Number(text)))
          throw new Error("Invalid native command record count");
        return Number(text);
      };
      for (const line of lines) {
        if (line.length > MAX_RECORD || /[^\x20-\x7e]/u.test(line.slice(3)))
          throw new Error("Invalid native command record bytes");
        const carrier = line.slice(0, 3);
        if (carrier !== "\x01\x01\x01" && carrier !== "\x02\x02\x02")
          throw new Error("Missing native command stream carrier");
        const fields = line.slice(3).split(" ");
        if (fields.slice(0, 3).join(" ") !== header)
          throw new Error("Native command record identity mismatch");
        const kind = fields[3];
        if (kind === "START") {
          if (fields.length !== 4 || begun || carrier !== "\x01\x01\x01")
            throw new Error("Invalid native command start record");
          begun = true;
        } else if (kind === "DATA" || kind === "EOF") {
          const name = fields[4];
          if (
            fields.length !== 8 ||
            (name !== "stdout" && name !== "stderr") ||
            (name === "stdout" ? carrier !== "\x01\x01\x01" || !begun : carrier !== "\x02\x02\x02")
          )
            throw new Error("Invalid native command stream record");
          const stream = streams[name];
          if (stream.eof || integer(fields[5]!) !== stream.sequence)
            throw new Error("Discontinuous native command stream record");
          const bytes = integer(fields[6]!);
          const payload = fields[7]!;
          if (kind === "DATA") {
            const chunk = Buffer.from(payload, "base64");
            if (
              !bytes ||
              payload.length > PAYLOAD ||
              chunk.toString("base64") !== payload ||
              chunk.length !== bytes
            )
              throw new Error("Invalid native command byte payload");
            stream.chunks.push(chunk);
            stream.sequence++;
            stream.bytes += bytes;
            if (!Number.isSafeInteger(stream.bytes))
              throw new Error("Unsafe native command byte total");
          } else {
            if (bytes !== stream.bytes || payload !== digest(Buffer.concat(stream.chunks)))
              throw new Error("Native command stream EOF integrity mismatch");
            stream.eof = true;
          }
        } else if (kind === "EXIT") {
          if (
            fields.length !== 5 ||
            !begun ||
            !streams.stdout.eof ||
            exit !== null ||
            carrier !== "\x01\x01\x01"
          )
            throw new Error("Invalid native command exit record");
          exit = integer(fields[4]!);
          if (exit > 255) throw new Error("Unsafe native command exit");
        } else throw new Error("Unknown native command record");
      }
      if (exit !== null && physicalExit !== null && exit !== physicalExit)
        throw new Error("Original native command exit mismatch");
      if (
        !begun ||
        incomplete ||
        !streams.stdout.eof ||
        !streams.stderr.eof ||
        exit === null ||
        physicalExit === null
      )
        return null;
      const decoder = () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      return {
        stdout: decoder().decode(Buffer.concat(streams.stdout.chunks)),
        stderr: decoder().decode(Buffer.concat(streams.stderr.chunks)),
        exitCode: exit,
      };
    },
  };
}
