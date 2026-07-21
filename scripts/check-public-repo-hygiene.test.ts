import { describe, expect, test } from "bun:test";
import {
  auditCatalogSnapshot,
  auditPublicText,
  auditSymlinkTarget,
} from "./check-public-repo-hygiene";

describe("public repository hygiene", () => {
  test("accepts portable public fixtures", () => {
    expect(
      auditPublicText(
        "fixture.ts",
        "const roots = ['/home/user/repo', '/Users/runner/repo']; const email = 'user@example.com'; const device = 'dev-desktop';",
      ),
    ).toEqual([]);
  });

  test("rejects personal paths, mail, private worktrees, issues, and agent docs", () => {
    const personalHome = ["/home/", "alice/private-repo"].join("");
    const personalMail = ["alice@", "gmail.com"].join("");
    const privateWorktree = [".claude/", "worktrees/private-branch"].join("");
    const privateIssue = ["cloudgeni ", "#123"].join("");
    const privatePlan = [".agent/", "private-plan.md"].join("");
    const retiredDesignPath = [
      "docs/design/sandbox",
      "-surfacing/",
      "mod",
      "ules/01-lease.md",
    ].join("");
    const retiredDesignTerm = ["dos", "sier"].join("");
    const internalIssue = ["OPE", "-123"].join("");
    const compactIssue = ["ope", "123Fixture"].join("");
    const identifierIssue = ["__ope", "9SetQueueLoading"].join("");
    const workLabel = ["SPIKE", "-7"].join("");
    const milestone = ["M", "12"].join("");
    const privateCodename = ["pelo", "ton"].join("");
    const personalName = ["J", "\u00f8", "rgen"].join("");
    const machineStore = ["/nix/store/", "a".repeat(32), "-chromium/bin/chromium"].join("");
    const findings = auditPublicText(
      "fixture.ts",
      [
        `const root = '${personalHome}';`,
        `const email = '${personalMail}';`,
        `const worktree = '${privateWorktree}';`,
        `const issue = '${privateIssue}';`,
        `const plan = '${privatePlan}';`,
        `const retiredPath = '${retiredDesignPath}';`,
        `const retiredTerm = '${retiredDesignTerm}';`,
        `const issue = '${internalIssue}';`,
        `const compactIssue = '${compactIssue}';`,
        `const identifierIssue = '${identifierIssue}';`,
        `const workLabel = '${workLabel}';`,
        `const milestone = '${milestone}';`,
        `const codename = '${privateCodename}';`,
        `const person = '${personalName}';`,
        `const browser = '${machineStore}';`,
      ].join("\n"),
    );

    expect(findings.map((finding) => finding.reason).sort()).toEqual(
      [
        "non-generic home path",
        "internal issue reference",
        "internal issue reference",
        "internal issue reference",
        "internal work label",
        "machine-specific Nix store path",
        "personal email address",
        "personal name",
        "private .agent document reference",
        "private issue reference",
        "private project codename",
        "private worktree path",
        "retired internal design-record path",
        "retired internal design-record terminology",
        "retired milestone label",
      ].sort(),
    );
  });

  test("does not rewrite immutable migration comments", () => {
    const privatePlan = [".agent/", "private-plan.md"].join("");
    expect(
      auditPublicText(
        "packages/db/drizzle/0024_sandboxes_enrollments_metrics.sql",
        `-- historical source: ${privatePlan}`,
      ),
    ).toEqual([]);
  });

  test("does not exempt newly added migrations", () => {
    const internalIssue = ["OPE", "-999"].join("");
    expect(
      auditPublicText(
        "packages/db/drizzle/9999_new_migration.sql",
        `-- historical source: ${internalIssue}`,
      ).map((finding) => finding.reason),
    ).toEqual(["internal issue reference"]);
  });

  test("reports an underscored issue identifier on its exact source line", () => {
    const identifierIssue = ["__ope", "9SetQueueLoading"].join("");
    expect(auditPublicText("fixture.ts", `safe line\n${identifierIssue}`)).toEqual([
      { file: "fixture.ts", line: 2, reason: "internal issue reference" },
    ]);
  });

  test("rejects more personal exposure shapes", () => {
    const source = [
      ["person", "@proton.me"].join(""),
      ["/home/", "private-user"].join(""),
      ["jor", "gen-mbp"].join(""),
    ].join("\n");
    expect(
      auditPublicText("fixture.ts", source)
        .map((finding) => finding.reason)
        .sort(),
    ).toEqual(["non-generic home path", "personal device label", "personal email address"].sort());
  });

  test("allows only the exact public fitness catalog object", () => {
    const publicName = ["Pelo", "ton"].join("");
    const publicDomain = ["one", ["pelo", "ton"].join(""), ".com"].join("");
    const source = JSON.stringify(
      {
        importRows: [
          {
            domain: publicDomain,
            name: publicName,
            mcpUrl: `https://${publicDomain}/mcp`,
            logoSourceUrl: `https://integrations.sh/logo/${publicDomain}`,
          },
          { domain: "unrelated.example", note: publicName },
        ],
      },
      null,
      2,
    );
    expect(
      auditPublicText("data/catalog/integrations-snapshot.json", source).map(
        (finding) => finding.reason,
      ),
    ).toEqual(["private project codename"]);
  });

  test("rejects absolute and machine-specific symlink targets", () => {
    const privateHome = ["/home/", "private-user/repo"].join("");
    expect(
      auditSymlinkTarget("result", privateHome)
        .map((finding) => finding.reason)
        .sort(),
    ).toEqual(["absolute symlink target", "non-generic home path"].sort());
    expect(
      auditSymlinkTarget("portable", "../packages/core").map((finding) => finding.reason),
    ).toEqual(["symlink target escapes repository"]);
    expect(auditSymlinkTarget("packages/runtime/portable", "../core")).toEqual([]);
  });

  test("rejects generic retired evidence-script references", () => {
    const evidenceScript = ["packages/react/scripts/m", "9-evidence.mjs"].join("");
    expect(auditPublicText("fixture.ts", evidenceScript).map((finding) => finding.reason)).toEqual([
      "retired internal design-record path",
    ]);
  });

  test("rejects MCP URLs retained in catalog diagnostics", () => {
    const findings = auditCatalogSnapshot({
      importRows: [
        {
          domain: "safe.example",
          name: "Safe",
          mcpUrl: "https://safe.example/mcp",
          transport: "streamable-http",
        },
      ],
      skipped: [
        {
          domain: "rejected.example",
          mcpUrl: "https://rejected.example/mcp?token=fixture-secret",
          reason: "credential_query_parameter",
        },
      ],
    });

    expect(findings.map((finding) => finding.reason)).toEqual([
      "rejected catalog diagnostic retains an MCP URL",
      "persisted catalog MCP URL rejected for credential_query_parameter",
    ]);
  });

  test("requires every skipped diagnostic to carry an explicit null MCP URL", () => {
    const findings = auditCatalogSnapshot({
      importRows: [],
      skipped: [{ domain: "missing-null.example", reason: "opaque_path_segment" }],
    });
    expect(findings.map((finding) => finding.reason)).toEqual([
      "rejected catalog diagnostic retains an MCP URL",
    ]);
  });
});
