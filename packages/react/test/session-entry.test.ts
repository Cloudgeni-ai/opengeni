import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { build } from "vite";

const packageRoot = join(import.meta.dir, "..");
const sessionEntry = join(packageRoot, "src/session.ts");
function importSpecifiersOf(source: string): string[] {
  const specifiers: string[] = [];
  const pattern =
    /(?:import|export)\b[^;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function resolveRelative(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // Try the next supported source form.
    }
  }
  return null;
}

describe("session-only entry", () => {
  test("reaches only session React, SDK, and local source", () => {
    const visited = new Set<string>();
    const thirdParty = new Set<string>();
    const queue = [sessionEntry];

    while (queue.length > 0) {
      const file = queue.pop();
      if (!file || visited.has(file)) continue;
      visited.add(file);
      for (const specifier of importSpecifiersOf(readFileSync(file, "utf8"))) {
        const local = resolveRelative(specifier, file);
        if (local) queue.push(local);
        else thirdParty.add(specifier);
      }
    }

    expect(visited.has(join(packageRoot, "src/timeline/index.ts"))).toBe(false);
    expect(visited.has(join(packageRoot, "src/provider.tsx"))).toBe(false);
    expect(visited.has(join(packageRoot, "src/session-context.ts"))).toBe(true);
    expect([...visited].some((file) => file.includes("/src/components/"))).toBe(false);
    expect([...visited].some((file) => file.includes("/src/commands/"))).toBe(false);
    // Refusal copy and the controller's model labels/order are explicit pure
    // SDK leaves, not permission to import contracts/server/workbench barrels.
    expect([...thirdParty].sort()).toEqual([
      "@opengeni/sdk",
      "@opengeni/sdk/allowance-refusal",
      "@opengeni/sdk/learning-refusal",
      "@opengeni/sdk/model-display",
      "@opengeni/sdk/model-picker-order",
      // The new-conversation controller imports only the voice model type.
      "@opengeni/sdk/realtime",
      // Unsent answers drop Other on a secret approval card: an id-only leaf.
      "@opengeni/sdk/secret-use-approval",
      // The timeline's task usage-limit stop: a zod-free refusal leaf.
      "@opengeni/sdk/session-usage-limits",
      // Timeline ordering shared with server-side conversation snapshots.
      "@opengeni/sdk/timeline-order",
      "react",
    ]);
    expect(visited.size).toBeGreaterThan(5);
  });

  test("builds from the public package subpath without the workbench graph", async () => {
    const transformed = new Set<string>();
    const result = await build({
      configFile: false,
      root: packageRoot,
      logLevel: "silent",
      plugins: [
        {
          name: "session-entry-closure",
          transform(_code, id) {
            transformed.add(id.split("?")[0] ?? id);
            return null;
          },
        },
      ],
      build: {
        write: false,
        minify: true,
        rollupOptions: {
          input: join(import.meta.dir, "fixtures/session-consumer.ts"),
          external: [
            "react",
            "react/jsx-runtime",
            "@opengeni/sdk",
            "@opengeni/sdk/allowance-refusal",
            "@opengeni/sdk/learning-refusal",
            "@opengeni/sdk/timeline-order",
          ],
        },
      },
    });

    if (Array.isArray(result) || !("output" in result)) {
      throw new Error("Expected a single completed Vite build output");
    }

    const reactSources = [...transformed].filter((id) => id.includes("/packages/react/src/"));
    expect(reactSources.some((id) => id.endsWith("/src/session.ts"))).toBe(true);
    expect(reactSources.some((id) => id.endsWith("/src/timeline/index.ts"))).toBe(false);
    expect(reactSources.some((id) => id.endsWith("/src/provider.tsx"))).toBe(false);
    expect(reactSources.some((id) => id.endsWith("/src/session-context.ts"))).toBe(true);
    expect(reactSources.some((id) => id.endsWith("/src/older-history.ts"))).toBe(true);
    expect(reactSources.some((id) => id.includes("/src/components/"))).toBe(false);
    expect(reactSources.some((id) => id.includes("/src/commands/"))).toBe(false);
    expect(reactSources.some((id) => id.includes("/src/realtime/"))).toBe(false);
    // Keep the session-only closure explicit: adding a source requires reviewing
    // whether it belongs to this provider-neutral public subpath.
    expect(reactSources.some((id) => id.endsWith("/src/conversation-timeline.ts"))).toBe(true);
    // Image presentation belongs to the renderer, not the readable projection.
    expect(reactSources.some((id) => id.endsWith("/src/timeline/presented-image.ts"))).toBe(false);
    // Vite transforms the optional resolver even when this fixture tree-shakes
    // its invocation; production browser tests verify its on-click chunk load.
    expect(reactSources.some((id) => id.endsWith("/src/hooks/latest-question.ts"))).toBe(true);
    expect(reactSources.some((id) => id.endsWith("/src/lib/error-message.ts"))).toBe(true);
    // Pure provider-recovery copy used by failure presentation; no React graph.
    expect(reactSources.some((id) => id.endsWith("/src/lib/provider-recovery.ts"))).toBe(true);
    // Pure compaction failure copy shared by the projection; no React graph.
    expect(reactSources.some((id) => id.endsWith("/src/timeline/compaction-copy.ts"))).toBe(true);
    expect(reactSources.some((id) => id.endsWith("/src/hooks/use-session-conversation.ts"))).toBe(
      true,
    );
    expect(reactSources.some((id) => id.endsWith("/src/hooks/use-new-conversation.ts"))).toBe(true);
    // Host-localizable copy: the dependency-free text runtime and its English defaults.
    expect(reactSources.some((id) => id.endsWith("/src/messages/runtime.tsx"))).toBe(true);
    expect(reactSources.some((id) => id.endsWith("/src/messages/en.ts"))).toBe(true);
    // Pure single-Send wording overrides for embedders; types only from the runtime.
    expect(reactSources.some((id) => id.endsWith("/src/messages/single-send.ts"))).toBe(true);
    // Shared reads: the model catalog store and the deployment config read.
    expect(reactSources.some((id) => id.endsWith("/src/hooks/shared-query.ts"))).toBe(true);
    expect(reactSources.some((id) => id.endsWith("/src/lib/client-config-read.ts"))).toBe(true);
    // Pure refused-save copy shared by the projection; no React graph.
    expect(reactSources.some((id) => id.endsWith("/src/timeline/learning-refusal-copy.ts"))).toBe(
      true,
    );
    // Retained conversation views for a reopen, on the shared-query store.
    expect(reactSources.some((id) => id.endsWith("/src/hooks/session-view-cache.ts"))).toBe(true);
    // Custom layouts mark an open conversation read through the shared hook and its pure model.
    expect(
      reactSources.some((id) => id.endsWith("/src/hooks/use-session-read-acknowledgement.ts")),
    ).toBe(true);
    expect(reactSources.some((id) => id.endsWith("/src/session-attention-model.ts"))).toBe(true);
    // Dependency-free turnless-output gap signal the live history shares with the terminal.
    expect(reactSources.some((id) => id.endsWith("/src/hooks/turnless-output-gaps.ts"))).toBe(true);
    // Exact reads of tool outputs a turn's step page delivered as previews.
    expect(reactSources.some((id) => id.endsWith("/src/hooks/tool-output-reads.ts"))).toBe(true);
    // The live stream's head read joins the conversation's fresh detail read.
    expect(reactSources.some((id) => id.endsWith("/src/lib/session-detail-read.ts"))).toBe(true);
    // Dependency-free wake detection: the live stream rejoins after a sleep.
    expect(reactSources.some((id) => id.endsWith("/src/hooks/page-wake.ts"))).toBe(true);
    // Why a message can't start: the pure admission model, its headless hook and the
    // provider-neutral machine read it uses to offer allowed machines.
    expect(reactSources.some((id) => id.endsWith("/src/session-admission-model.ts"))).toBe(true);
    expect(reactSources.some((id) => id.endsWith("/src/hooks/use-session-start.ts"))).toBe(true);
    expect(reactSources.some((id) => id.endsWith("/src/hooks/use-machines.ts"))).toBe(true);
    expect(reactSources.some((id) => id.endsWith("/src/hooks/shared-machines-list.ts"))).toBe(true);
    // Dependency-free unsent-answer store the pending-question read prunes.
    expect(reactSources.some((id) => id.endsWith("/src/human-input-draft-store.ts"))).toBe(true);
    // The startup row projection shared by the web app and embedded conversations.
    expect(reactSources.some((id) => id.endsWith("/src/lib/session-startup-timeline.tsx"))).toBe(
      true,
    );
    // The projection shows a `tool_invoke` call as the tool it ran, reading its
    // arguments with the pure tool-argument parser (tree-shaken to that read).
    expect(reactSources.some((id) => id.endsWith("/src/timeline/invoked-tool.ts"))).toBe(true);
    expect(reactSources.some((id) => id.endsWith("/src/timeline/parsers.ts"))).toBe(true);
    // The renderer-free transient-failure rules the composer uses to hold a
    // send calmly while Opengeni is updating.
    expect(reactSources.some((id) => id.endsWith("/src/lib/transient-retry.ts"))).toBe(true);
    // Pure rule for questions another agent answered: the projection folds them into work.
    expect(reactSources.some((id) => id.endsWith("/src/timeline/agent-work-human-input.ts"))).toBe(
      true,
    );
    // Up-arrow recall of the person's latest waiting prompt.
    expect(reactSources.some((id) => id.endsWith("/src/hooks/use-queued-prompt-recall.ts"))).toBe(
      true,
    );
    // The draft store asks the pure human-input rules which questions offer Other.
    expect(reactSources.some((id) => id.endsWith("/src/human-input-model.ts"))).toBe(true);
    // Pure startup-step titles: an unclassified turn failure is named by the
    // step it failed at ("Sandbox didn't start") instead of its recorded text.
    expect(
      reactSources.some((id) => id.endsWith("/src/timeline/platform-activity-presentation.ts")),
    ).toBe(true);
    expect(reactSources.length).toBe(60);

    const chunks = result.output.filter((item) => item.type === "chunk");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.code.length ?? Number.POSITIVE_INFINITY).toBeLessThan(100_000);
    const text = chunks.map((chunk) => chunk.code).join("\n");

    expect(text).not.toContain("@uiw/react-codemirror");
    expect(text).not.toContain("@xterm/");
    expect(text).not.toContain("@novnc/novnc");
    expect(text).not.toContain("@pierre/diffs");
  });
});
