import { describe, expect, test } from "bun:test";
import { commandStepTitle, redactSignedUrls, toolRowPresentation } from "../src/timeline-model";
import type { ToolCallItem } from "../src/timeline/types";
import { createOpenGeniText } from "../src/messages/runtime";

const t = createOpenGeniText();
const done = (command: string) => commandStepTitle(t, command, "done");

const SAS =
  "https://store.blob.core.windows.net/exports/email-review.json?sv=2024-11-04&se=2026-10-29T10%3A00Z&sr=b&sp=r&sig=AbC%2Bdef123%3D";

function exec(cmd: string, partial: Partial<ToolCallItem> = {}): ToolCallItem {
  return {
    kind: "tool-call",
    id: "t1",
    turnId: null,
    callId: "c1",
    name: "exec_command",
    arguments: { cmd },
    output: "Process exited with code 0\nOutput:\nok",
    raw: undefined,
    status: "complete",
    occurredAt: "2026-10-29T00:00:00.000Z",
    ...partial,
  };
}

describe("commands in plain words", () => {
  test.each([
    [`curl -fsSL '${SAS}' -o /workspace/email-review.json`, "Downloaded email-review.json"],
    [`wget -q ${SAS}`, "Downloaded email-review.json"],
    ["curl -s https://api.example.com/v1/items | jq '.items'", "Got data from api.example.com"],
    ["curl -X POST -d '{}' https://hooks.example.com/x", "Sent data to hooks.example.com"],
    [
      `ogtool call mcp_ce39f0__search_messages '{"query":"payment"}' | jq '.messages[]'`,
      "Search messages",
    ],
    [
      `"$OPENGENI_CODEMODE_NATIVE_CLIENT" codemode call interaction.browser.open '{}'`,
      "Opened the browser",
    ],
    ["ogtool list", "Looked up tools"],
    ["cat /workspace/report.md", "Read report.md"],
    ["sed -n '1,80p' src/app.ts", "Read app.ts"],
    ["cat notes.md; head -20 data.csv", "Read 2 files"],
    ["cd /workspace && python3 make_chart.py --out chart.png", "Ran make_chart.py"],
    ["python3 - <<'EOF'\nimport matplotlib\nprint('x > y')\nEOF", "Ran Python code"],
    ["node -e 'console.log(1)'", "Ran JavaScript code"],
    ["bash -lc 'cat /tmp/out.txt'", "Read out.txt"],
    ["cat > /workspace/summary.md <<'EOF'\n# Summary\nrm -rf /\nEOF", "Wrote summary.md"],
    ["echo hello > greeting.txt", "Wrote greeting.txt"],
    ["cat notes.md 2>/dev/null || true", "Read notes.md"],
    ["curl -s https://api.example.com/x 2>&1 | head -5", "Got data from api.example.com"],
    ["echo done > /dev/null", null],
    ["pip install matplotlib", "Installed matplotlib"],
    ["npm install", "Installed packages"],
    ["mkdir -p /workspace/out && cp a.png /workspace/out/", "Copied a.png"],
    ["ls -la /workspace/output", "Looked through output"],
    ["rg -n 'payment warning' src", "Searched for “payment warning”"],
    ["grep -rE '^(a|b)+$' .", "Searched files"],
    ["pandoc report.md -o report.docx", "Converted report.md"],
    ["unzip -o archive.zip -d out", "Unpacked archive.zip"],
    ["git status && git diff", "Checked changes"],
    ["bun test ./test/a.test.ts", "Ran tests"],
    ["rm -f /tmp/scratch.json", "Deleted scratch.json"],
    ["export X=1 && sleep 5", "Waited"],
  ])("%s", (command, expected) => {
    expect(done(command)).toBe(expected);
  });

  test("reads in the ongoing form while running", () => {
    expect(commandStepTitle(t, "cat report.md", "running")).toBe("Reading report.md");
  });

  test("returns null for a command it can't place", () => {
    expect(done("make -j8")).toBeNull();
    expect(done("echo hi")).toBeNull();
    expect(done("")).toBeNull();
  });

  test("never names a file from a glob or a variable", () => {
    expect(done("cat *.md")).toBe("Read a file");
    expect(done('curl -o "$OUT" https://x.example/a')).toBe("Downloaded a file");
  });
});

describe("signed links", () => {
  test("hide the signature but keep the host and path", () => {
    expect(redactSignedUrls(`curl '${SAS}' -o x`)).toBe(
      "curl 'https://store.blob.core.windows.net/exports/email-review.json?[signature hidden]' -o x",
    );
    expect(
      redactSignedUrls(
        "https://b.s3.amazonaws.com/k?X-Amz-Algorithm=AWS4&X-Amz-Credential=a&X-Amz-Signature=f",
      ),
    ).toBe("https://b.s3.amazonaws.com/k?[signature hidden]");
  });

  test("leave ordinary links alone", () => {
    const text = "see https://example.com/search?q=cats&page=2 and https://example.com/a";
    expect(redactSignedUrls(text)).toBe(text);
  });
});

describe("command rows", () => {
  test("title the step in plain words and keep the command, unsigned, in the body", () => {
    const row = toolRowPresentation(
      t,
      exec(`curl -fsSL '${SAS}' -o /workspace/email-review.json`, {
        output: `Process exited with code 0\nOutput:\nsaved ${SAS}`,
      }),
    );
    expect(row.title).toBe("Downloaded email-review.json");
    expect(row.titleMono).toBeUndefined();
    expect(row.body.kind).toBe("term");
    if (row.body.kind !== "term") return;
    expect(row.body.command).toContain("curl -fsSL");
    expect(row.body.command).toContain("email-review.json?[signature hidden]");
    expect(JSON.stringify(row)).not.toContain("sig=");
    expect(JSON.stringify(row)).not.toContain("sv=2024");
  });

  test("a command that exited badly keeps the ongoing form beside its exit chip", () => {
    const row = toolRowPresentation(
      t,
      exec("python3 make_chart.py", { output: "Process exited with code 1\nOutput:\nTraceback" }),
    );
    expect(row.title).toBe("Running make_chart.py");
    expect(row.chip).toEqual({ tone: "bad", text: "exit 1" });
  });

  test("plain tool details still name no file, link or tool from the command", () => {
    const row = toolRowPresentation(t, exec("cat /workspace/report.md"), { details: "plain" });
    expect(row.title).toBe("Ran a command");
    expect(row.body).toEqual({ kind: "none" });
  });

  test("an unplaceable command still says it ran a command", () => {
    expect(toolRowPresentation(t, exec("make -j8")).title).toBe("Ran a command");
  });
});
