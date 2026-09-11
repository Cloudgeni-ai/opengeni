// Explicit cross-language fixture: build the native example first. Ordinary
// runtime-only jobs skip this test; native verification must run it explicitly.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ControlRequest, ControlResponse } from "@opengeni/agent-proto";
import { applyDiff } from "@openai/agents";
import { SelfhostedSession, setSelfhostedApplyDiff } from "../src/sandbox/selfhosted/session";
import { NatsControlRpc } from "../src/sandbox/selfhosted/control-rpc";

const binary =
  process.env.OPENGENI_TRANSACTIONAL_FS_FIXTURE ??
  resolve(import.meta.dir, "../../../agent/target/debug/examples/transactional-fs-fixture");
if (process.env.OPENGENI_REQUIRE_NATIVE_FS_TEST === "1" && !existsSync(binary)) {
  throw new Error("Required native transactional filesystem fixture was not built");
}

for (const interrupt of [false, true]) {
  test.skipIf(process.platform !== "linux" || !existsSync(binary))(
    `TypeScript editor drives native transactional files: ${interrupt ? "abandoned staging cleanup" : "verified large replacement"}`,
    async () => {
      setSelfhostedApplyDiff(applyDiff);
      const root = await mkdtemp(join(tmpdir(), "opengeni-native-write-"));
      const path = join(root, "synthetic.md");
      const original = "# Before\n" + "Synthetic cross-language fixture.\n".repeat(80000);
      await writeFile(path, original, { mode: 0o640 });
      const child = Bun.spawn([binary, root, "1"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = new Response(child.stderr).text();
      const reader = child.stdout.getReader();
      let buffered = new Uint8Array(0);
      const take = async (length: number): Promise<Uint8Array> => {
        while (buffered.length < length) {
          const next = await reader.read();
          if (next.done) throw new Error("Native fixture ended before its response frame");
          const joined = new Uint8Array(buffered.length + next.value.length);
          joined.set(buffered);
          joined.set(next.value, buffered.length);
          buffered = joined;
        }
        const result = buffered.slice(0, length);
        buffered = buffered.slice(length);
        return result;
      };
      let chunks = 0;
      let cancels = 0;
      const rpc = new NatsControlRpc(async () => ({
        request: async (_subject, payload) => {
          if (payload.byteLength > 1024 * 1024)
            throw Object.assign(new Error("MAX_PAYLOAD_EXCEEDED"), {
              code: "MAX_PAYLOAD_EXCEEDED",
            });
          const request = ControlRequest.decode(payload);
          if (request.op?.$case === "writeChunk") {
            chunks += 1;
            if (interrupt && chunks === 2)
              throw Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
          }
          if (request.op?.$case === "opCancel") cancels += 1;
          const header = new Uint8Array(4);
          new DataView(header.buffer).setUint32(0, payload.byteLength, false);
          child.stdin.write(header);
          child.stdin.write(payload);
          await child.stdin.flush();
          const responseHeader = await take(4);
          const length = new DataView(responseHeader.buffer).getUint32(0, false);
          if (length > 1024 * 1024)
            throw new Error("Native response exceeded simulated transport budget");
          const data = await take(length);
          expect(ControlResponse.decode(data).requestId).toBe(request.requestId);
          return { data };
        },
      }));
      try {
        const session = new SelfhostedSession({
          workspaceId: "11111111-1111-4111-8111-111111111111",
          agentId: "synthetic-agent",
          connectionInstanceId: "22222222-2222-4222-8222-222222222222",
          workspaceRoot: root,
          relay: { host: "relay.test", port: 443, tls: true },
          epoch: 1,
          controlRpc: rpc,
          transactionalFsWriteSupported: true,
        });
        const update = session.createEditor().updateFile({
          path,
          diff: "@@\n-# Before\n+# After\n Synthetic cross-language fixture.",
        });
        if (interrupt) await expect(update).rejects.toThrow("Cancellation");
        else await update;
        expect(await readFile(path, "utf8")).toBe(
          interrupt ? original : original.replace("# Before", "# After"),
        );
        expect((await stat(path)).mode & 0o777).toBe(0o640);
        // Check while the native registry is still alive: process exit must not
        // conceal a caller-side failure to cancel an abandoned live transfer.
        expect(await readdir(root)).toEqual(["synthetic.md"]);
        expect(cancels).toBe(interrupt ? 1 : 0);
        expect(chunks).toBeGreaterThan(1);
        child.stdin.end();
        expect(await child.exited).toBe(0);
        expect(await stderr).toBe("");
      } finally {
        if (child.exitCode === null) child.kill();
        await child.exited;
        reader.releaseLock();
        await rm(root, { recursive: true, force: true });
      }
    },
    30000,
  );
}
