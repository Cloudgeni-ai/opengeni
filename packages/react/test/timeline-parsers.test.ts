import { describe, expect, test } from "bun:test";
import {
  applyPatchOps,
  controlCaret,
  execTruncated,
  isApplyPatch,
  isExecSessionLostBanner,
  looksBinary,
  parseExecBannerSessionId,
  parseToolArgs,
  redactSecrets,
  sandboxCommandExitCode,
  stripExecBanner,
  tailPeek,
  unwrapMcpOutput,
  v4aToGitFileDiff,
  type ApplyPatchOperation,
} from "../src/timeline";
import { gitFileDiffToPatch } from "../src/index";

/* ----------------------------------------------------------------------------
   Unit tests for the pure provider-shape parsers (src/timeline/parsers.ts).

   Each parser is a pure mirror of a sandbox/V4A wire shape; these lock the
   contract the renderers and the turn-summary facet counter depend on.
   -------------------------------------------------------------------------- */

describe("exec banner parsing", () => {
  test("sandboxCommandExitCode recovers the exit code", () => {
    expect(sandboxCommandExitCode("Process exited with code 0\nOutput:\nok")).toBe(0);
    expect(sandboxCommandExitCode("Process exited with code 6")).toBe(6);
    expect(sandboxCommandExitCode("Process exited with code -1")).toBe(-1);
  });

  test("sandboxCommandExitCode is null when no banner / nullish input", () => {
    expect(sandboxCommandExitCode("just some stdout")).toBeNull();
    expect(sandboxCommandExitCode(null)).toBeNull();
    expect(sandboxCommandExitCode(undefined)).toBeNull();
  });

  test("parseExecBannerSessionId recovers a backgrounded process session id", () => {
    expect(parseExecBannerSessionId("Process running with session ID 42\nOutput:\ntail -f")).toBe(
      42,
    );
  });

  test("parseExecBannerSessionId only reads the banner, not the stdout body", () => {
    // A session-id-looking string in the OUTPUT must not be mistaken for the banner.
    expect(
      parseExecBannerSessionId(
        "Process exited with code 0\nOutput:\nProcess running with session ID 99",
      ),
    ).toBeNull();
  });

  test("parseExecBannerSessionId is null for a finished (exited) process and nullish input", () => {
    expect(parseExecBannerSessionId("Process exited with code 0\nOutput:\n")).toBeNull();
    expect(parseExecBannerSessionId(null)).toBeNull();
  });

  test("stripExecBanner peels the banner down to stdout", () => {
    expect(stripExecBanner("Chunk ID abc\nProcess exited with code 0\nOutput:\nhello\nworld")).toBe(
      "hello\nworld",
    );
  });

  test("stripExecBanner handles a leading Output marker and passes through bannerless text", () => {
    expect(stripExecBanner("Output:\nhello")).toBe("hello");
    expect(stripExecBanner("no banner here")).toBe("no banner here");
    expect(stripExecBanner(null)).toBe("");
  });

  test("execTruncated detects the sandbox truncation markers", () => {
    expect(execTruncated("Total output lines: 5000")).toBe(true);
    expect(execTruncated("...128 tokens truncated...")).toBe(true);
    expect(execTruncated("[...512 characters truncated")).toBe(true);
    expect(execTruncated("clean output")).toBe(false);
  });

  test("isExecSessionLostBanner detects a vanished write_stdin PTY", () => {
    expect(isExecSessionLostBanner("write_stdin failed: session not found: 7")).toBe(true);
    expect(isExecSessionLostBanner("write_stdin failed: session not found: nope")).toBe(false);
    expect(isExecSessionLostBanner("all good")).toBe(false);
  });
});

describe("binary + control-character helpers", () => {
  test("looksBinary flags NUL bytes and ELF magic", () => {
    expect(looksBinary("text\x00more")).toBe(true);
    expect(looksBinary("ELFblah")).toBe(true);
    expect(looksBinary("plain ascii")).toBe(false);
  });

  test("controlCaret renders control chars as caret notation", () => {
    expect(controlCaret("")).toBe("^C");
    expect(controlCaret("")).toBe("^D");
    expect(controlCaret("ab")).toBe("a^Cb");
    expect(controlCaret("no controls")).toBe("no controls");
  });
});

describe("V4A apply_patch parsing", () => {
  test("v4aToGitFileDiff structures an update hunk with add/del/context counts", () => {
    const op: ApplyPatchOperation = {
      type: "update_file",
      path: "src/app.ts",
      diff: "@@ -1,3 +1,3 @@\n context\n-old line\n+new line",
    };
    const diff = v4aToGitFileDiff(op);
    expect(diff.path).toBe("src/app.ts");
    expect(diff.status).toBe("modified");
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
    expect(diff.hunks).toHaveLength(1);
  });

  test("v4aToGitFileDiff treats create_file as added and counts additions without a @@ anchor", () => {
    const op: ApplyPatchOperation = {
      type: "create_file",
      path: "new.txt",
      diff: "+line one\n+line two",
    };
    const diff = v4aToGitFileDiff(op);
    expect(diff.status).toBe("added");
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(0);
  });

  test("v4aToGitFileDiff marks a delete_file and ignores any diff body", () => {
    const diff = v4aToGitFileDiff({ type: "delete_file", path: "gone.txt", diff: "ignored" });
    expect(diff.status).toBe("deleted");
    expect(diff.hunks).toHaveLength(0);
    expect(diff.additions).toBe(0);
  });

  test("v4aToGitFileDiff marks a move as renamed and tracks oldPath", () => {
    const diff = v4aToGitFileDiff({
      type: "update_file",
      path: "old/p.ts",
      moveTo: "new/p.ts",
      diff: "@@ -1 +1 @@\n context",
    });
    expect(diff.status).toBe("renamed");
    expect(diff.path).toBe("new/p.ts");
    expect(diff.oldPath).toBe("old/p.ts");
  });

  test("v4aToGitFileDiff THROWS on a malformed update with no @@ anchor (the fallback path)", () => {
    const op: ApplyPatchOperation = {
      type: "update_file",
      path: "x.ts",
      diff: "this has content but no hunk anchor",
    };
    expect(() => v4aToGitFileDiff(op)).toThrow(/malformed V4A/);
  });

  test("v4aToGitFileDiff tolerates an empty update diff (no throw)", () => {
    const diff = v4aToGitFileDiff({ type: "update_file", path: "x.ts", diff: "" });
    expect(diff.status).toBe("modified");
    expect(diff.hunks).toHaveLength(0);
  });

  test("create_file with no @@ anchor round-trips to a valid unified patch (expanded diff is NOT empty)", () => {
    // Regression: a create_file body without a `@@` anchor synthesized a hunk
    // with a degenerate `@@ +1 @@` header. f.additions was counted correctly
    // (the collapsed chip showed +N), but gitFileDiffToPatch emitted the broken
    // header verbatim, so the generic unified-diff parser (Pierre) rendered ZERO
    // lines on expand → collapsed +N / expanded +0. The emitted patch must carry
    // a structurally valid `@@ -0,0 +1,N @@` header and all N added lines.
    const N = 17;
    const body = Array.from({ length: N }, (_, i) => `+line ${i + 1}`).join("\n");
    const file = v4aToGitFileDiff({ type: "create_file", path: "src/new.ts", diff: body });

    // The chip count (additions) is what the collapsed header shows.
    expect(file.additions).toBe(N);

    const patch = gitFileDiffToPatch(file);
    const patchLines = patch.split("\n");

    // A valid create header — NOT the degenerate `@@ +1 @@`.
    const header = patchLines.find((l) => l.startsWith("@@"));
    expect(header).toBe(`@@ -0,0 +1,${N} @@`);
    expect(patch).not.toContain("@@ +1 @@");

    // Every added line is present in the patch body — what Pierre renders on
    // expand must equal the collapsed chip count.
    const addedLines = patchLines.filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    expect(addedLines).toHaveLength(N);
    expect(addedLines[0]).toBe("+line 1");
    expect(addedLines[N - 1]).toBe(`+line ${N}`);
  });

  test("gitFileDiffToPatch regenerates a header missing the unified range form", () => {
    // Defense in depth: a hunk whose header lacks the `-x,y +a,b` ranges gets a
    // regenerated header derived from the range fields rather than emitted as-is.
    const patch = gitFileDiffToPatch({
      path: "f.txt",
      oldPath: null,
      status: "added",
      isBinary: false,
      isImage: false,
      additions: 2,
      deletions: 0,
      truncated: false,
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 2,
          header: "@@ +1 @@",
          lines: [
            { type: "add", oldNo: null, newNo: 1, text: "a" },
            { type: "add", oldNo: null, newNo: 2, text: "b" },
          ],
        },
      ],
    });
    expect(patch).toContain("@@ -0,0 +1,2 @@");
    expect(patch).not.toContain("@@ +1 @@");
  });

  test("applyPatchOps normalizes both wire shapes", () => {
    expect(applyPatchOps({ operation: { type: "update_file", path: "a" } })).toHaveLength(1);
    expect(
      applyPatchOps({
        operations: [
          { type: "update_file", path: "a" },
          { type: "delete_file", path: "b" },
        ],
      }),
    ).toHaveLength(2);
    expect(applyPatchOps({})).toHaveLength(0);
    expect(applyPatchOps(null)).toHaveLength(0);
  });

  test("isApplyPatch matches by raw.type and by name", () => {
    expect(isApplyPatch({ name: "anything", raw: { type: "apply_patch_call" } })).toBe(true);
    expect(isApplyPatch({ name: "apply_patch_call", raw: undefined })).toBe(true);
    expect(isApplyPatch({ name: "exec_command", raw: { type: "function_call" } })).toBe(false);
    expect(isApplyPatch({ name: "exec_command", raw: null })).toBe(false);
  });
});

describe("secret redaction", () => {
  test("redactSecrets masks secret-looking keys deeply, case-insensitively", () => {
    const redacted = redactSecrets({
      value: "raw",
      Secret: "s",
      token: "t",
      api_key: "k",
      "signing-key": "sk",
      nested: { password: "p", keep: "visible" },
      list: [{ apiKey: "x" }],
    }) as Record<string, unknown>;
    expect(redacted.value).toBe("••••");
    expect(redacted.Secret).toBe("••••");
    expect(redacted.token).toBe("••••");
    expect(redacted.api_key).toBe("••••");
    expect(redacted["signing-key"]).toBe("••••");
    expect((redacted.nested as Record<string, unknown>).password).toBe("••••");
    expect((redacted.nested as Record<string, unknown>).keep).toBe("visible");
    expect(((redacted.list as unknown[])[0] as Record<string, unknown>).apiKey).toBe("••••");
  });

  test("redactSecrets leaves non-secret primitives untouched", () => {
    expect(redactSecrets("plain")).toBe("plain");
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBeNull();
  });
});

describe("tool-args + tail helpers", () => {
  test("parseToolArgs accepts a JSON string, an object, and degrades to {}", () => {
    expect(parseToolArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArgs({ a: 1 })).toEqual({ a: 1 });
    expect(parseToolArgs("not json")).toEqual({});
    expect(parseToolArgs(null)).toEqual({});
    expect(parseToolArgs("[1,2]")).toEqual([1, 2] as unknown as Record<string, unknown>);
  });

  test("tailPeek returns the last non-empty line", () => {
    expect(tailPeek("first\nsecond\nthird")).toBe("third");
    expect(tailPeek("  only  ")).toBe("only");
    expect(tailPeek("\n\n")).toBe("");
  });
});

describe("MCP output unwrap", () => {
  test("unwrapMcpOutput flattens an MCP content array", () => {
    expect(unwrapMcpOutput({ content: [{ type: "text", text: "hello" }] })).toEqual({
      text: "hello",
      isError: false,
    });
  });

  test("unwrapMcpOutput surfaces isError and finds the text part among others", () => {
    const result = unwrapMcpOutput({
      isError: true,
      content: [
        { type: "image", data: "..." },
        { type: "text", text: "boom" },
      ],
    });
    expect(result).toEqual({ text: "boom", isError: true });
  });

  test("unwrapMcpOutput passes a plain string through", () => {
    expect(unwrapMcpOutput("plain stdout")).toEqual({ text: "plain stdout", isError: false });
  });

  test("unwrapMcpOutput handles nullish output", () => {
    expect(unwrapMcpOutput(null)).toEqual({ text: "", isError: false });
  });
});
