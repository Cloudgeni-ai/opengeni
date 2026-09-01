import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionClientLike } from "@opengeni/sdk/session";
import type { OpenGeniSvelteContext } from "../src/context";

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

  test("accepts the documented baseline session client without optional capabilities", () => {
    const client = {} as SessionClientLike;
    const context: OpenGeniSvelteContext = { client, workspaceId: "workspace-test" };
    expect(context.client).toBe(client);
    expect(context.fileAttachmentClient).toBeUndefined();
  });
});
