const sourceRoots = [
  "apps",
  "packages",
  "scripts",
  "deploy",
  ".github",
  ".agents",
  "README.md",
  "AGENTS.md",
  ".env.example",
];

type Finding = {
  file: string;
  message: string;
};

const files = await listFiles(sourceRoots);
const findings: Finding[] = [];

for (const file of files) {
  if (file === "scripts/check-workspace-billing-static.ts") {
    continue;
  }
  const text = await Bun.file(file).text().catch(() => "");
  if (!text) {
    continue;
  }
  checkUnscopedOperationalRoutes(file, text, findings);
  checkForbiddenProviderImports(file, text, findings);
  checkDeletedBillingPortal(file, text, findings);
  checkGithubWebhookAdvertising(file, text, findings);
  checkMcpDefaults(file, text, findings);
}

if (findings.length > 0) {
  console.error("Workspace/billing static guard failed:");
  for (const finding of findings) {
    console.error(`- ${finding.file}: ${finding.message}`);
  }
  process.exit(1);
}

console.log("Workspace/billing static guard passed.");

async function listFiles(roots: string[]): Promise<string[]> {
  const proc = Bun.spawn(["rg", "--files", ...roots], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`rg --files failed: ${stderr.trim()}`);
  }
  return stdout.split("\n").map((line) => line.trim()).filter((line) => line && !line.includes("/node_modules/"));
}

function checkUnscopedOperationalRoutes(file: string, text: string, out: Finding[]): void {
  if (!isSourceLike(file)) {
    return;
  }
  const forbidden = [
    /["'`]\/v1\/sessions(?:\/|["'`])/,
    /["'`]\/v1\/files(?:\/|["'`])/,
    /["'`]\/v1\/document-bases(?:\/|["'`])/,
    /["'`]\/v1\/scheduled-tasks(?:\/|["'`])/,
    /["'`]\/v1\/mcp(?:\/|["'`])/,
    /["'`]\/v1\/github\/app(?:\/|["'`])/,
    /["'`]\/v1\/github\/repositories(?:\/|["'`])/,
  ];
  if (forbidden.some((pattern) => pattern.test(text))) {
    out.push({ file, message: "contains a deleted unscoped operational /v1 route; use /v1/workspaces/:workspaceId/..." });
  }
}

function checkForbiddenProviderImports(file: string, text: string, out: Finding[]): void {
  const normalized = file.replace(/\\/g, "/");
  const betterAuthImport = /(?:from\s+["']better-auth["']|import\s+["']better-auth["']|require\(["']better-auth["']\)|["@]better-auth\/)/.test(text);
  if (betterAuthImport && !normalized.startsWith("apps/api/src/auth/") && normalized !== "apps/api/package.json") {
    out.push({ file, message: "imports Better Auth outside the managed auth module" });
  }
  if (/from\s+["']stripe["']/.test(text)) {
    if (normalized !== "apps/api/src/routes/billing.ts") {
      out.push({ file, message: "imports Stripe outside billing route/provider code" });
    }
  }
}

function checkDeletedBillingPortal(file: string, text: string, out: Finding[]): void {
  if (isSourceLike(file) && text.includes("/v1/billing/portal")) {
    out.push({ file, message: "contains first-release-excluded /v1/billing/portal route or client call" });
  }
}

function checkGithubWebhookAdvertising(file: string, text: string, out: Finding[]): void {
  if (file === "packages/github/src/index.ts" && (text.includes("hook_attributes") || text.includes("/v1/github/webhook"))) {
    out.push({ file, message: "advertises GitHub webhooks without a signed/idempotent /v1/github/webhook receiver" });
  }
}

function checkMcpDefaults(file: string, text: string, out: Finding[]): void {
  if (!isSourceLike(file)) {
    return;
  }
  if (text.includes("/v1/mcp") && !text.includes("/v1/workspaces/{workspaceId}/mcp") && !text.includes("/v1/workspaces/${workspaceId}/mcp")) {
    out.push({ file, message: "contains unscoped first-party MCP default; use /v1/workspaces/{workspaceId}/mcp" });
  }
}

function isSourceLike(file: string): boolean {
  return /\.(ts|tsx|js|jsx|yaml|yml|json|md|example)$/.test(file);
}
