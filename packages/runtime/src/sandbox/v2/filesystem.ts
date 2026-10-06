import { createHash } from "node:crypto";
import { posix } from "node:path";
import { JournalBindingError } from "./journal-client";
import type { MachineSandboxSession } from "./machine-session";
import { validatedViewImageMediaType } from "../../view-image-validation";

/** Text editing and read-only images have independent bounded transfers. */
export const SANDBOX_V2_EDITOR_FILE_BYTES = 128 * 1024;
export const SANDBOX_V2_IMAGE_FILE_BYTES = 2 * 1024 * 1024;
export class SandboxV2FilesystemFailure extends Error {
  readonly code = "SANDBOX_V2_FILESYSTEM_FAILED";
}
type FileRequest =
  | { kind: "read"; path: string }
  | { kind: "create"; path: string; content: string }
  | { kind: "update"; path: string; content: string; baseSha256: string; moveTo?: string }
  | { kind: "delete"; path: string };

// Linux descriptor-relative paths keep the caller's path below its already-open
// workspace directory. Task paths never become code or shell text. The helper
// needs the image's Bun and procfs; unsupported images fail visibly. This does
// not establish a guest-isolation or native-journal integrity guarantee.
const fileProgram = String.raw`
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
const input = JSON.parse(await Bun.stdin.text());
const {root, request, limit, tooLargeMessage} = input;
const {O_RDONLY,O_WRONLY,O_CREAT,O_EXCL,O_NOFOLLOW,O_DIRECTORY,O_NONBLOCK} = fs.constants;
const fds = [];
let stage;
let changed = false;
const fail = message => { const error = new Error(message); error.fileFailure = true; throw error; };
const parent = (path, create) => {
  const parts = path.split("/");
  if (!parts.length || parts.some(p => !p || p === "." || p === ".." || p.includes("\0"))) fail("Invalid workspace file path");
  let fd = fs.openSync(root,O_RDONLY|O_DIRECTORY|O_NOFOLLOW); fds.push(fd);
  for (const part of parts.slice(0,-1)) {
    const next = "/proc/self/fd/" + fd + "/" + part;
    if (create) { try { fs.mkdirSync(next,{mode:0o755}); } catch(error) { if(error.code !== "EEXIST") throw error; } }
    fd = fs.openSync(next,O_RDONLY|O_DIRECTORY|O_NOFOLLOW); fds.push(fd);
  }
  return {fd,path:"/proc/self/fd/"+fd+"/"+parts.at(-1)};
};
const read = path => {
  const fd = fs.openSync(path,O_RDONLY|O_NOFOLLOW|O_NONBLOCK); fds.push(fd);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) fail("Path is not a regular file");
  if (stat.size > limit) fail(tooLargeMessage);
  const bytes = Buffer.alloc(limit+1);
  let size = 0;
  while(size < bytes.length) { const n = fs.readSync(fd,bytes,size,bytes.length-size,null); if(!n)break; size += n; }
  if(size > limit) fail(tooLargeMessage);
  return {bytes:bytes.subarray(0,size),mode:stat.mode&0o777};
};
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
try {
  if(process.platform !== "linux" || !Number.isInteger(O_NOFOLLOW) || !Number.isInteger(O_DIRECTORY)) fail("Native text editing requires Linux descriptor support");
  const source = parent(request.path,request.kind === "create");
  if (request.kind === "read") {
    process.stdout.write(JSON.stringify({status:"completed",base64:read(source.path).bytes.toString("base64")}));
  } else if (request.kind === "delete") {
    read(source.path);
    fs.unlinkSync(source.path); changed = true; fs.fsyncSync(source.fd);
    process.stdout.write(JSON.stringify({status:"completed"}));
  } else {
    const bytes = Buffer.from(request.content,"utf8");
    if(bytes.length > limit) fail(tooLargeMessage);
    const original = request.kind === "update" ? read(source.path) : null;
    if(original && digest(original.bytes) !== request.baseSha256) fail("File changed since the retained patch read");
    const move = request.kind === "update" && request.moveTo && request.moveTo !== request.path;
    const destination = move ? parent(request.moveTo,true) : source;
    stage = "/proc/self/fd/"+destination.fd+"/.opengeni-edit-"+randomUUID();
    const out = fs.openSync(stage,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,original?.mode ?? 0o644); fds.push(out);
    if(original) fs.fchmodSync(out,original.mode);
    fs.writeFileSync(out,bytes); fs.fsyncSync(out);
    if(original && digest(read(source.path).bytes) !== request.baseSha256) fail("File changed before patch publication");
    if(request.kind === "create" || move) fs.linkSync(stage,destination.path);
    else fs.renameSync(stage,destination.path);
    changed = true;
    if(move) {
      if(digest(read(source.path).bytes) !== request.baseSha256) fail("Destination was written; source changed before move cleanup");
      fs.unlinkSync(source.path); fs.fsyncSync(source.fd);
    }
    fs.fsyncSync(destination.fd);
    process.stdout.write(JSON.stringify({status:"completed"}));
  }
} catch(error) {
  const message = error.fileFailure ? error.message : error.code === "ENOENT" ? "File or parent directory is missing" : error.code === "EEXIST" ? "Destination already exists" : "Filesystem operation was refused";
  process.stdout.write(JSON.stringify({status:"failed",message:(changed ? "Publication occurred; completion was not verified. " : "")+message}));
} finally {
  if(stage) { try { fs.unlinkSync(stage); } catch {} }
  for(const fd of fds.reverse()) { try { fs.closeSync(fd); } catch {} }
}
`;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const command = `/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/bun --no-env-file --config=/dev/null --no-addons -e ${quote(fileProgram)}`;

/** Explicit child identities under one accepted patch call. They survive
 * observer replacement, including partial stdin delivery. Publication checks
 * the retained base but does not claim atomic CAS against unrelated writers;
 * a move publishes a new destination then removes its verified source. Neither file bytes,
 * the command body nor a traversal counter mints a replacement operation. */
export class SandboxV2TextFilesystem {
  constructor(
    private readonly root: string,
    private readonly operation: (key: string) => MachineSandboxSession,
    private readonly options: { signal?: AbortSignal; runAs?: string } = {},
  ) {
    if (!posix.isAbsolute(root) || posix.normalize(root) === "/" || root.includes("\0"))
      throw new JournalBindingError("A native editor workspace root is required");
  }
  private path(input: string): string {
    if (typeof input !== "string" || !input || input.length > 4096 || input.includes("\0"))
      throw new SandboxV2FilesystemFailure("Invalid workspace file path");
    const root = posix.normalize(this.root);
    const relative = posix.isAbsolute(input)
      ? input.startsWith(`${root}/`)
        ? input.slice(root.length + 1)
        : ""
      : input;
    if (!relative || relative.split("/").some((p) => !p || p === "." || p === ".."))
      throw new SandboxV2FilesystemFailure("File path must stay inside the workspace");
    return relative;
  }
  private async request(
    key: string,
    input: FileRequest,
    limit = SANDBOX_V2_EDITOR_FILE_BYTES,
  ): Promise<{ base64?: string }> {
    this.options.signal?.throwIfAborted();
    const request = { ...input, path: this.path(input.path) };
    if (request.kind === "update" && request.moveTo) request.moveTo = this.path(request.moveTo);
    if ("content" in request && Buffer.byteLength(request.content) > SANDBOX_V2_EDITOR_FILE_BYTES)
      throw new SandboxV2FilesystemFailure("File exceeds the native text editor limit");
    const payload = JSON.stringify({
      root: this.root,
      request,
      limit,
      tooLargeMessage:
        limit === SANDBOX_V2_IMAGE_FILE_BYTES
          ? "Image exceeds the 2 MiB limit"
          : "File exceeds the native text editor limit",
    });
    const session = this.operation(key);
    let result = await session.exec({
      cmd: command,
      yieldTimeMs: 0,
      maxOutputTokens: 65536,
      ...(this.options.runAs ? { runAs: this.options.runAs } : {}),
    });
    if (result.sessionId !== undefined) {
      await this.operation(`${key}/input`).writeCommandInput({
        sessionId: result.sessionId,
        chars: payload,
        ...(this.options.signal ? { signal: this.options.signal } : {}),
      });
      await this.operation(`${key}/close`).closeStdin(result.sessionId, this.options.signal);
    }
    while (result.sessionId !== undefined) {
      this.options.signal?.throwIfAborted();
      result = await session.pollCommand({
        sessionId: result.sessionId,
        yieldTimeMs: 1000,
        maxOutputTokens: 65536,
        ...(this.options.signal ? { signal: this.options.signal } : {}),
      });
    }
    this.options.signal?.throwIfAborted();
    if (result.exitCode !== 0 || result.omittedOutputBytes)
      throw new JournalBindingError(
        "Native filesystem response has no complete successful outcome",
      );
    let reply: unknown;
    try {
      reply = JSON.parse(result.stdout);
    } catch {
      throw new JournalBindingError("Native filesystem acknowledgement is unavailable");
    }
    if (!reply || typeof reply !== "object" || !("status" in reply))
      throw new JournalBindingError("Native filesystem acknowledgement is invalid");
    if (reply.status === "failed" && "message" in reply && typeof reply.message === "string")
      throw new SandboxV2FilesystemFailure(reply.message);
    if (reply.status !== "completed")
      throw new JournalBindingError("Native filesystem completion is unavailable");
    return "base64" in reply && typeof reply.base64 === "string" ? { base64: reply.base64 } : {};
  }
  private async readBytes(key: string, path: string, limit: number): Promise<Buffer> {
    const reply = await this.request(key, { kind: "read", path }, limit);
    if (typeof reply.base64 !== "string")
      throw new JournalBindingError("Native file read has no retained bytes");
    const bytes = Buffer.from(reply.base64, "base64");
    if (bytes.length > limit || bytes.toString("base64") !== reply.base64)
      throw new JournalBindingError("Native file read bytes are invalid");
    return bytes;
  }
  async readImage(path: string): Promise<string> {
    const bytes = await this.readBytes("image/read", path, SANDBOX_V2_IMAGE_FILE_BYTES);
    const mediaType = validatedViewImageMediaType(bytes);
    if (!mediaType)
      throw new SandboxV2FilesystemFailure("File is not a supported PNG, JPEG or WebP image");
    return `data:${mediaType};base64,${bytes.toString("base64")}`;
  }
  async readText(path: string): Promise<string> {
    const bytes = await this.readBytes("patch/read", path, SANDBOX_V2_EDITOR_FILE_BYTES);
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new SandboxV2FilesystemFailure("File is not UTF-8 text");
    }
  }
  async create(path: string, content: string): Promise<void> {
    await this.request("patch/create", { kind: "create", path, content });
  }
  async update(path: string, content: string, base: string, moveTo?: string): Promise<void> {
    await this.request("patch/update", {
      kind: "update",
      path,
      content,
      baseSha256: createHash("sha256").update(base).digest("hex"),
      ...(moveTo ? { moveTo } : {}),
    });
  }
  async delete(path: string): Promise<void> {
    await this.request("patch/delete", { kind: "delete", path });
  }
}
