import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const webSourceRoot = join(repositoryRoot, "apps/web/src");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return await sourceFiles(path);
      return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
    }),
  );
  return nested.flat();
}

describe("public realtime ownership", () => {
  test("keeps realtime UI and controller orchestration out of apps/web", async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(webSourceRoot)) {
      const source = await readFile(file, "utf8");
      const path = relative(repositoryRoot, file);
      for (const [label, pattern] of [
        [
          "app-owned realtime control",
          /(?:function|const)\s+(?:RealtimeVoiceControl|SessionRealtimeControl|NewSessionRealtimeControl|RealtimeModelPickerMenu)\b/,
        ],
        [
          "app-owned realtime hook",
          /(?:function|const)\s+(?:useSessionRealtime|useRealtimeModelSelection)\b/,
        ],
        [
          "direct realtime controller import",
          /@opengeni\/sdk\/(?:realtime|codex-realtime-controller|gateway-realtime-transport)/,
        ],
        [
          "direct realtime controller construction",
          /create(?:Codex|Session)RealtimeController\s*\(/,
        ],
        [
          "app-owned realtime transport selection",
          /(?:gateway|codex)-realtime-owner|createGatewayRealtimeTransportStarter/,
        ],
      ] as const) {
        if (pattern.test(source)) violations.push(`${path}: ${label}`);
      }
    }

    expect(violations).toEqual([]);
  });

  test("dogfoods the public React realtime subpath in both composer routes", async () => {
    const sessionRoute = await readFile(join(webSourceRoot, "routes/session.tsx"), "utf8");
    const newSessionRoute = await readFile(
      join(webSourceRoot, "routes/sessions-index.tsx"),
      "utf8",
    );
    expect(sessionRoute).toContain('import("@opengeni/react/realtime")');
    expect(newSessionRoute).toContain('from "@opengeni/react/realtime"');
  });
});
