import { expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { createSandboxClient } from "../src/sandbox";
import {
  SandboxChannelAService,
  type ChannelAExecArgs,
  type ChannelASession,
} from "../src/sandbox/channel-a";
import { parseExecBannerSessionId } from "../src/sandbox/exec-banner";
import { executeSynchronousCommand } from "../src/sandbox/synchronous-command";

// Opt-in, real provider proof. The isolated sandbox is deleted in finally.
test.skipIf(process.env.OPENGENI_LIVE_MODAL_FILESYSTEM !== "1")(
  "live Modal internal filesystem commands await exact yielded completion",
  async () => {
    const client = createSandboxClient(
      testSettings({
        sandboxBackend: "modal",
        modalAppName: "opengeni-ope701-filesystem-smoke",
        modalImageRef: "python:3.12-slim",
        modalWorkspacePersistence: "tar",
        modalTimeoutSeconds: 300,
        modalIdleTimeoutSeconds: 180,
      }),
    ) as { create(): Promise<ChannelASession & { delete(): Promise<void> }> };
    const actual = await client.create();
    let starts = 0;
    let yielded = 0;
    const session = new Proxy(actual, {
      get(target, property) {
        if (property === "execCommand") {
          return async (args: ChannelAExecArgs) => {
            starts++;
            // Force a real SDK yield before running the original filesystem
            // script. This does not synthesize output or completion evidence.
            const result = await actual.execCommand!({
              ...args,
              cmd: `sleep 2\n${args.cmd}`,
              yieldTimeMs: 1,
            });
            if (parseExecBannerSessionId(result) !== null) yielded++;
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = new SandboxChannelAService({ session, workspaceRoot: "/workspace" });
    const directory = ".agents/skills/ope701-live-fixture";
    const files = Array.from({ length: 12 }, (_, index) => ({
      path: `support/${index}.txt`,
      content: `${index}\n${"fixture ".repeat(4096)}`,
    }));
    try {
      const first = await service.fsWriteFiles({ directory, files });
      expect(first.written).toEqual(files.map((file) => file.path));
      expect(first.unchanged).toEqual([]);
      expect(starts).toBeGreaterThan(2);
      expect(yielded).toBe(starts);

      const repeated = await service.fsWriteFiles({ directory, files });
      expect(repeated.written).toEqual([]);
      expect(repeated.unchanged).toEqual(files.map((file) => file.path));
      for (const file of [files[0]!, files.at(-1)!]) {
        const read = await service.fsRead({
          path: `${directory}/${file.path}`,
          encoding: "utf8",
          maxBytes: 100_000,
        });
        expect(read.content).toBe(file.content);
      }
      const listing = await service.fsList({
        path: `${directory}/support`,
        depth: 1,
        maxEntries: 100,
        includeHidden: true,
      });
      expect(listing.root.children).toHaveLength(files.length);

      const startsBeforeFailure = starts;
      const failure = await executeSynchronousCommand(session, {
        cmd: "printf 'before-exit|'; printf 'diagnostic' >&2; sleep 2; exit 7",
        yieldTimeMs: 1,
        maxOutputTokens: 1000,
      });
      expect(failure.exitCode).toBe(7);
      expect(failure.stdout).toContain("before-exit|");
      // SDK setup observation preserves its provider's existing stream shape;
      // durable Modal router split-stream custody is covered separately.
      expect(failure.stdout + failure.stderr).toContain("diagnostic");
      expect(starts - startsBeforeFailure).toBe(1);
      expect(yielded).toBe(starts);
    } finally {
      await actual.delete();
    }
  },
  240_000,
);
