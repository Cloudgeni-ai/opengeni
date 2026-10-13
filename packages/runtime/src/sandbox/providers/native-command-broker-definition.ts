/** Internal command definition for the keeper-owned broker. Encoding is not
 * command admission: only the separately qualified initial broker may decode
 * this body and start an idle sealed supervisor after durable host authority.
 * There is no shell interpolation, environment inheritance or runAs fallback.
 */
import { z } from "zod";

export const NATIVE_BROKER_DEFINITION_MAX_BYTES = 256 * 1024;
export const NATIVE_BROKER_DEFINITION_MAX_ENTRIES = 1024;
export const NATIVE_BROKER_DEFINITION_MAX_STRING_BYTES = 128 * 1024 - 1;
const magic = Buffer.from("OGCD1\0", "ascii");
const schema = z
  .object({
    mode: z.enum(["pipe", "pty"]),
    cwd: z.string(),
    argv: z.array(z.string()).min(1).max(NATIVE_BROKER_DEFINITION_MAX_ENTRIES),
    env: z.array(z.tuple([z.string(), z.string()])).max(NATIVE_BROKER_DEFINITION_MAX_ENTRIES),
    rows: z.number().int().min(0).max(65535),
    columns: z.number().int().min(0).max(65535),
  })
  .strict();
export type NativeBrokerCommandDefinition = z.infer<typeof schema>;

function invalid(): never {
  // Definitions can include secrets. Neither input nor field names enter errors.
  throw new Error("Native broker command definition is invalid or exceeds its bound");
}

function text(value: string): Buffer {
  if (value.includes("\0")) invalid();
  const encoded = Buffer.from(value, "utf8");
  if (
    encoded.length > NATIVE_BROKER_DEFINITION_MAX_STRING_BYTES ||
    encoded.toString("utf8") !== value
  )
    invalid();
  return encoded;
}

function validate(definition: unknown): NativeBrokerCommandDefinition {
  const result = schema.safeParse(definition);
  if (!result.success) invalid();
  const value = result.data;
  if (!value.cwd.startsWith("/") || !value.argv[0]) invalid();
  if (
    value.mode === "pty" ? !value.rows || !value.columns : value.rows !== 0 || value.columns !== 0
  )
    invalid();
  const keys = new Set<string>();
  for (const [key, entry] of value.env) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || keys.has(key)) invalid();
    if (
      Buffer.byteLength(key) + 1 + Buffer.byteLength(entry) >
      NATIVE_BROKER_DEFINITION_MAX_STRING_BYTES
    )
      invalid();
    keys.add(key);
  }
  return value;
}

/** Big-endian, length-prefixed UTF-8 with no normalization or inheritance.
 * Header: OGCD1 NUL, mode byte (0 pipe/1 PTY), reserved zero byte, uint16 rows,
 * uint16 columns, uint32 argc, uint32 envc. Then cwd, argv strings, and explicit
 * ordered environment key/value strings, each prefixed by a uint32 byte length.
 */
export function encodeNativeBrokerCommandDefinition(
  definition: NativeBrokerCommandDefinition,
): Uint8Array {
  const value = validate(definition);
  const strings = [value.cwd, ...value.argv, ...value.env.flatMap(([key, entry]) => [key, entry])];
  // Bound aggregate allocation before constructing any payload buffers.
  let total = 20;
  for (const string of strings) {
    const length = Buffer.byteLength(string, "utf8");
    if (length > NATIVE_BROKER_DEFINITION_MAX_STRING_BYTES) invalid();
    total += 4 + length;
    if (total > NATIVE_BROKER_DEFINITION_MAX_BYTES) invalid();
  }
  const output = Buffer.allocUnsafe(total);
  magic.copy(output);
  output[6] = value.mode === "pty" ? 1 : 0;
  output[7] = 0;
  output.writeUInt16BE(value.rows, 8);
  output.writeUInt16BE(value.columns, 10);
  output.writeUInt32BE(value.argv.length, 12);
  output.writeUInt32BE(value.env.length, 16);
  let offset = 20;
  for (const string of strings) {
    const encoded = text(string);
    output.writeUInt32BE(encoded.length, offset);
    offset += 4;
    encoded.copy(output, offset);
    offset += encoded.length;
  }
  return output;
}

export function decodeNativeBrokerCommandDefinition(
  bytes: Uint8Array,
): NativeBrokerCommandDefinition {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 20 ||
    bytes.length > NATIVE_BROKER_DEFINITION_MAX_BYTES
  )
    invalid();
  const input = Buffer.from(bytes);
  if (!input.subarray(0, 6).equals(magic) || input[6]! > 1 || input[7] !== 0) invalid();
  const argc = input.readUInt32BE(12);
  const envc = input.readUInt32BE(16);
  if (
    !argc ||
    argc > NATIVE_BROKER_DEFINITION_MAX_ENTRIES ||
    envc > NATIVE_BROKER_DEFINITION_MAX_ENTRIES
  )
    invalid();
  let offset = 20;
  function read(): string {
    if (offset + 4 > input.length) invalid();
    const size = input.readUInt32BE(offset);
    offset += 4;
    if (size > NATIVE_BROKER_DEFINITION_MAX_STRING_BYTES || size > input.length - offset) invalid();
    const encoded = input.subarray(offset, offset + size);
    offset += size;
    const value = encoded.toString("utf8");
    if (!text(value).equals(encoded)) invalid();
    return value;
  }
  const cwd = read();
  const argv = Array.from({ length: argc }, read);
  const env: [string, string][] = Array.from({ length: envc }, () => [read(), read()]);
  if (offset !== input.length) invalid();
  return validate({
    mode: input[6] ? "pty" : "pipe",
    rows: input.readUInt16BE(8),
    columns: input.readUInt16BE(10),
    cwd,
    argv,
    env,
  });
}
