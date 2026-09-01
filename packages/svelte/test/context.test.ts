import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("native Svelte provider authority", () => {
  test("keys a context-setting boundary on every authority-bearing field", () => {
    const provider = readFileSync(
      resolve(import.meta.dir, "../src/components/OpenGeniProvider.svelte"),
      "utf8",
    );
    const boundary = readFileSync(
      resolve(import.meta.dir, "../src/components/OpenGeniContextBoundary.svelte"),
      "utf8",
    );
    for (const field of [
      "client",
      "workspaceId",
      "sessionClient",
      "goalClient",
      "lineageClient",
      "humanInputClient",
      "mcpApprovalPolicyClient",
      "fileAttachmentClient",
    ]) {
      expect(provider).toContain(`{#key context.${field}}`);
    }
    expect(provider).toContain("<OpenGeniContextBoundary {context} {children} />");
    expect(boundary).toContain("setOpenGeniContext(context)");
    expect(boundary).toContain("{@render children?.()}");
  });
});
