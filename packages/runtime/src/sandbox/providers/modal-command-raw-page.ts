import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ModalRouterProviderCommand } from "@opengeni/contracts";
import type { ProviderCommandOutput } from "../provider-command-session";
import { decodePage } from "./modal-legacy-command-control";
import { MODAL_ROUTER_READ_PAGE_BYTES } from "./modal-command-router-wire";

const RawStream = z
  .object({
    bytes: z
      .instanceof(Uint8Array)
      .transform((bytes): Uint8Array<ArrayBufferLike> => bytes)
      .refine(
        (bytes) => bytes.byteLength <= MODAL_ROUTER_READ_PAGE_BYTES,
        "Raw page exceeded its bound",
      ),
    eof: z.boolean(),
  })
  .strict();
const RawExit = z.discriminatedUnion("source", [
  z.object({ source: z.literal("router_poll"), code: z.number().int().nullable() }).strict(),
  z.object({ source: z.literal("retained_terminal"), code: z.number().int() }).strict(),
]);
const RawPage = z
  .object({
    protocol: z.literal("modal-router-raw-page-v1"),
    expected: ModalRouterProviderCommand,
    command: ModalRouterProviderCommand,
    streams: z.object({ stdout: RawStream, stderr: RawStream }).strict(),
    exit: RawExit,
  })
  .strict();

/** Bounded native RPC bytes and their exact cursor projection. The source tag
 * distinguishes a fresh poll from previously captured terminal evidence; it
 * does not authenticate an object supplied by a caller. No Start, custody,
 * database settlement or parent completion authority is conveyed. */
export type ModalRawOutputPage = z.infer<typeof RawPage>;
export type ModalRawOutputStreams = ModalRawOutputPage["streams"];
export type ModalRawOutputExit = ModalRawOutputPage["exit"];
type NativeOutput = ProviderCommandOutput & {
  expected: ModalRouterProviderCommand;
  command: ModalRouterProviderCommand;
};

function project(
  expected: ModalRouterProviderCommand,
  streams: ModalRawOutputStreams,
  exit: ModalRawOutputExit,
): NativeOutput {
  const command = structuredClone(expected);
  const chunks: ProviderCommandOutput["chunks"] = [];
  for (const stream of ["stdout", "stderr"] as const) {
    const old = expected.streams[stream];
    const page = streams[stream];
    const decoded = decodePage(old.utf8Remainder, [page.bytes], page.eof);
    const byteOffset = old.byteOffset + page.bytes.byteLength;
    if (!Number.isSafeInteger(byteOffset)) throw new Error("Modal output offset exhausted");
    command.streams[stream] = {
      byteOffset,
      utf8Remainder: decoded.remainder,
      eof: page.eof,
      exitCode: page.eof ? exit.code : null,
    };
    if (decoded.text)
      chunks.push({
        stream,
        chunkId: `modal-router:${expected.execId}:${stream}:${old.byteOffset}:${byteOffset}:${page.eof ? 1 : 0}`,
        text: decoded.text,
      });
  }
  return {
    command,
    expected: structuredClone(expected),
    chunks,
    exitCode: command.streams.stdout.eof && command.streams.stderr.eof ? exit.code : null,
    providerExited: exit.code !== null,
    streamFidelity: expected.pty ? "merged" : "separate",
  };
}

/** Provider-private construction from joined read/poll replies. Keep the SDK
 * projection unchanged; this pure helper itself is not provider proof. */
export function collectModalRawOutputPage(
  command: ModalRouterProviderCommand,
  streams: ModalRawOutputStreams,
  exit: ModalRawOutputExit,
): { raw: ModalRawOutputPage; output: NativeOutput } {
  const expected = structuredClone(command);
  const captured = {
    stdout: { bytes: Buffer.from(streams.stdout.bytes), eof: streams.stdout.eof },
    stderr: { bytes: Buffer.from(streams.stderr.bytes), eof: streams.stderr.eof },
  };
  const output = project(expected, captured, exit);
  return {
    raw: {
      protocol: "modal-router-raw-page-v1",
      expected,
      command: structuredClone(output.command),
      streams: captured,
      exit: { ...exit },
    },
    output,
  };
}

/** Recompute decoded output from exact bytes, never caller-decoded text. The
 * current cursor must come from the caller's authoritative store. Equality
 * checks are not a database CAS; coherent bytes still need trusted acquisition
 * and atomic capture by the owner. */
export function reduceModalRawOutputPage(
  input: ModalRawOutputPage,
  current: ModalRouterProviderCommand,
): NativeOutput {
  const page = RawPage.parse(input);
  const expected = ModalRouterProviderCommand.parse(current);
  if (!isDeepStrictEqual(page.expected, expected))
    throw new Error("Raw page does not match the current native cursor");
  for (const stream of ["stdout", "stderr"] as const) {
    const old = expected.streams[stream];
    const raw = page.streams[stream];
    const remainder = Buffer.from(old.utf8Remainder, "base64");
    if (
      remainder.toString("base64") !== old.utf8Remainder ||
      remainder.length > 3 ||
      remainder.length > old.byteOffset ||
      (old.eof && remainder.length !== 0)
    )
      throw new Error("Raw page has an invalid saved UTF-8 remainder");
    if (old.eof && (!raw.eof || raw.bytes.byteLength !== 0))
      throw new Error("Raw page reopened or advanced a completed stream");
    if (old.exitCode !== null && page.exit.code !== old.exitCode)
      throw new Error("Raw page rewrote captured terminal evidence");
  }
  if (
    page.exit.source === "retained_terminal" &&
    (!expected.streams.stdout.eof ||
      !expected.streams.stderr.eof ||
      expected.streams.stdout.exitCode !== page.exit.code ||
      expected.streams.stderr.exitCode !== page.exit.code)
  )
    throw new Error("Raw page has no matching retained terminal evidence");
  const output = project(expected, page.streams, page.exit);
  if (!isDeepStrictEqual(page.command, output.command))
    throw new Error("Raw page cursor delta or remainder does not match its bytes");
  return output;
}
