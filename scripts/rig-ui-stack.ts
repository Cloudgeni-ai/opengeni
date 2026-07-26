// Dev-only screenshot stack for the Rigs UI (M5 verification).
//
// Boots the real API + web (vite dev) against ephemeral Postgres/NATS/Temporal,
// seeds the full rig state space into the local-mode "Local" workspace, then
// stays alive so a Playwright pass (scripts/rig-ui-shots.ts) can screenshot the
// real app. Vite dev hot-reloads UI edits, so the review loop is: edit → the
// stack HMRs → re-run the shots script. Ctrl-C (or killing the process) tears
// the containers down.
//
// Run: bun scripts/rig-ui-stack.ts  (backgrounded)
import { mkdirSync, writeFileSync } from "node:fs";

import {
  createDb,
  createRig,
  createRigChange,
  createRigVersion,
  createVariableSet,
  listRigVersions,
  recordAuditEvent,
  setWorkspaceDefaultRig,
  updateRigChangeStatus,
  type Database,
} from "@opengeni/db";
import {
  freePort,
  startProcess,
  startTestServices,
  waitFor,
  type StartedProcess,
  type TestServices,
} from "@opengeni/testing";

const repoRoot = new URL("..", import.meta.url).pathname;
const STATE_FILE = `${process.env.RIG_UI_STATE_DIR ?? "/tmp"}/rig-ui-stack.json`;

let services: TestServices | undefined;
let api: StartedProcess | undefined;
let web: StartedProcess | undefined;

async function main() {
  services = await startTestServices({ temporal: true });
  await services.migrate();
  const apiPort = await freePort();
  const webPort = await freePort();

  const env: Record<string, string> = {
    OPENGENI_ENVIRONMENT: "test",
    OPENGENI_DATABASE_URL: services.databaseUrl,
    OPENGENI_NATS_URL: services.natsUrl,
    OPENGENI_TEMPORAL_HOST: services.temporalHost,
    OPENGENI_TEMPORAL_NAMESPACE: "default",
    OPENGENI_TEMPORAL_TASK_QUEUE: `rig-ui-${crypto.randomUUID()}`,
    OPENGENI_API_HOST: "127.0.0.1",
    OPENGENI_API_PORT: String(apiPort),
    OPENGENI_PRODUCT_ACCESS_MODE: "local",
    OPENGENI_OPENAI_API_KEY: "test",
    OPENGENI_OPENAI_MODEL: "scripted-model",
    OPENGENI_SANDBOX_BACKEND: "none",
    OPENGENI_SANDBOX_PREPARATION_PROFILES: "none",
  };

  console.log("[rig-ui] starting api…");
  api = await startProcess(["bun", "apps/api/src/index.ts"], {
    cwd: repoRoot,
    env,
    ready: async () =>
      (await fetch(`http://127.0.0.1:${apiPort}/healthz`).catch(() => null))?.ok === true,
    timeoutMs: 90_000,
  });

  console.log("[rig-ui] starting web…");
  web = await startProcess(
    ["bun", "run", "vite", "dev", "--port", String(webPort), "--strictPort", "--host", "127.0.0.1"],
    {
      cwd: `${repoRoot}/apps/web`,
      env: { VITE_API_BASE_URL: `http://127.0.0.1:${apiPort}` },
      ready: async () =>
        (await fetch(`http://127.0.0.1:${webPort}`).catch(() => null))?.ok === true,
      timeoutMs: 60_000,
    },
  );

  // Force the local-mode workspace bootstrap, then read its ids from the API.
  await waitFor(
    async () =>
      (await fetch(`http://127.0.0.1:${apiPort}/v1/access/me`).catch(() => null))?.ok === true,
    { timeoutMs: 30_000 },
  );
  const workspaces = (await (
    await fetch(`http://127.0.0.1:${apiPort}/v1/workspaces`)
  ).json()) as Array<{ id: string; accountId: string; name: string }>;
  const local = workspaces.find((workspace) => workspace.name === "Local") ?? workspaces[0];
  if (!local) {
    throw new Error("Local workspace was not bootstrapped");
  }
  const workspaceId = local.id;
  const accountId = local.accountId;

  console.log(`[rig-ui] seeding workspace ${workspaceId}…`);
  const db = createDb(services.databaseUrl).db;
  await seed(db, accountId, workspaceId);

  mkdirSync(STATE_FILE.replace(/\/[^/]+$/, ""), { recursive: true });
  writeFileSync(
    STATE_FILE,
    JSON.stringify(
      { apiPort, webPort, accountId, workspaceId, baseUrl: `http://127.0.0.1:${webPort}` },
      null,
      2,
    ),
  );
  console.log(`[rig-ui] READY  web=http://127.0.0.1:${webPort}  workspace=${workspaceId}`);
  console.log(`[rig-ui] state written to ${STATE_FILE}. Leave this running; Ctrl-C to tear down.`);

  // Stay alive until killed, then tear the containers + child processes down.
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      console.log("[rig-ui] shutting down…");
      await web?.stop().catch(() => undefined);
      await api?.stop().catch(() => undefined);
      await services?.down().catch(() => undefined);
      resolve();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  });
}

async function seed(db: Database, accountId: string, workspaceId: string) {
  const ws = { accountId, workspaceId };

  // Two variable sets (values are write-only; the UI shows only counts).
  const stagingAws = await createVariableSet(db, {
    ...ws,
    name: "staging-aws",
    description: "Staging AWS credentials",
    variables: [
      { name: "AWS_ACCESS_KEY_ID", valueEncrypted: "enc" },
      { name: "AWS_SECRET_ACCESS_KEY", valueEncrypted: "enc" },
      { name: "AWS_REGION", valueEncrypted: "enc" },
    ],
  });
  const prodDb = await createVariableSet(db, {
    ...ws,
    name: "prod-postgres",
    description: "Production database connection",
    variables: [
      { name: "DATABASE_URL", valueEncrypted: "enc" },
      { name: "PGPASSWORD", valueEncrypted: "enc" },
    ],
  });

  // 1) The plain workspace default — stock image, no setup, no checks.
  await createRig(db, {
    ...ws,
    name: "default",
    description: "Workspace default machine — stock image, no setup script.",
    createdBy: "user:you",
  });

  // 2) The dev machine — real setup + checks, dense history, every change state.
  const dev = await createRig(db, {
    ...ws,
    name: "dev-machine",
    description: "Node + Python toolchain the app team builds on.",
    createdBy: "user:you",
    initialVersion: {
      image: "ghcr.io/opengeni/dev:base",
      setupScript: "apt-get update\napt-get install -y ripgrep jq",
      checks: [
        { name: "ripgrep present", command: "rg --version" },
        { name: "jq present", command: "jq --version" },
      ],
      defaultVariableSetIds: [stagingAws.id, prodDb.id],
      changelog: "Initial dev machine",
      createdBy: "user:you",
    },
  });

  const changelogs = [
    "Add pnpm",
    "Pin Node 20",
    "Add awscli v2",
    "Install postgresql-client",
    "Add docker CLI",
    "Cache pnpm store",
    "Add python3-venv",
    "Install gh CLI",
    "Add build-essential",
    "Bump base image to :2026-06",
    "Add uv package manager",
  ];
  const actors = [
    "user:alice",
    "session:9f2c1a7b-4d5e-6f70-8192-a3b4c5d6e7f8",
    "system",
    "user:you",
  ];
  let setup = "apt-get update\napt-get install -y ripgrep jq";
  for (let index = 0; index < changelogs.length; index += 1) {
    setup += `\n# ${changelogs[index]}\napt-get install -y tool-${index}`;
    await createRigVersion(
      db,
      workspaceId,
      dev.id,
      {
        image:
          index >= changelogs.length - 2
            ? "ghcr.io/opengeni/dev:2026-06"
            : "ghcr.io/opengeni/dev:base",
        setupScript: setup,
        checks: [
          { name: "ripgrep present", command: "rg --version" },
          { name: "jq present", command: "jq --version" },
          ...(index >= 4 ? [{ name: "docker present", command: "docker --version" }] : []),
        ],
        defaultVariableSetIds: [stagingAws.id, prodDb.id],
        changelog: changelogs[index] ?? null,
        createdBy: actors[index % actors.length] ?? null,
      },
      { activate: true },
    );
  }
  const devVersions = await listRigVersions(db, workspaceId, dev.id);
  const activeVersion = devVersions.find((version) => version.active) ?? devVersions[0]!;
  const prevVersion = devVersions.sort((a, b) => b.version - a.version)[1] ?? activeVersion;

  const passingChecks = [
    { name: "ripgrep present", command: "rg --version", exitCode: 0, output: "ripgrep 13.0.0" },
    { name: "jq present", command: "jq --version", exitCode: 0, output: "jq-1.7" },
    {
      name: "docker present",
      command: "docker --version",
      exitCode: 0,
      output: "Docker version 27.1.1, build 6312585",
    },
  ];

  // a) A merged setup command (auto-promoted on green).
  const merged = await createRigChange(db, {
    ...ws,
    rigId: dev.id,
    baseVersionId: prevVersion.id,
    kind: "setup_append",
    payload: { command: "npm i -g pnpm", note: "The team standardized on pnpm." },
    proposedBy: "session:9f2c1a7b-4d5e-6f70-8192-a3b4c5d6e7f8",
  });
  await updateRigChangeStatus(db, workspaceId, merged.id, {
    status: "merged",
    resultVersionId: activeVersion.id,
    verification: {
      startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      finishedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      passed: true,
      log: "+ pulling ghcr.io/opengeni/dev:base\n+ npm i -g pnpm\nadded 1 package in 2s\n+ running checks…\nrg --version -> ok\njq --version -> ok",
      checkResults: passingChecks,
    },
  });

  // b) A change currently verifying.
  const verifying = await createRigChange(db, {
    ...ws,
    rigId: dev.id,
    baseVersionId: activeVersion.id,
    kind: "setup_append",
    payload: { command: "apt-get install -y postgresql-client", note: "psql for migrations" },
    proposedBy: "user:alice",
  });
  await updateRigChangeStatus(db, workspaceId, verifying.id, {
    status: "verifying",
    verification: {
      startedAt: new Date(Date.now() - 20_000).toISOString(),
      log: "+ pulling image…\n+ starting clean sandbox…",
    },
  });

  // c) A rejected change — a check failed, with the log visible.
  const rejected = await createRigChange(db, {
    ...ws,
    rigId: dev.id,
    baseVersionId: activeVersion.id,
    kind: "setup_append",
    payload: { command: "pip install internal-tool", note: "Depends on our private PyPI." },
    proposedBy: "session:1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809",
  });
  await updateRigChangeStatus(db, workspaceId, rejected.id, {
    status: "rejected",
    verification: {
      startedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      finishedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      passed: false,
      log: "+ starting clean sandbox…\n+ pip install internal-tool\nERROR: Could not find a version that satisfies the requirement internal-tool\nERROR: No matching distribution found for internal-tool\n+ running checks…",
      checkResults: [
        { name: "ripgrep present", command: "rg --version", exitCode: 0, output: "ripgrep 13.0.0" },
        {
          name: "internal tool present",
          command: "internal-tool --version",
          exitCode: 127,
          output: "bash: internal-tool: command not found",
        },
      ],
    },
  });

  // d) A definition edit that PASSED and is awaiting a human promote.
  const verifiedEdit = await createRigChange(db, {
    ...ws,
    rigId: dev.id,
    baseVersionId: activeVersion.id,
    kind: "definition_edit",
    payload: {
      setupScript: `${setup}\n# add terraform\napt-get install -y terraform`,
      checks: [
        { name: "ripgrep present", command: "rg --version" },
        { name: "jq present", command: "jq --version" },
        { name: "docker present", command: "docker --version" },
        { name: "terraform present", command: "terraform version" },
      ],
      defaultVariableSetIds: [stagingAws.id, prodDb.id],
      changelog: "Add Terraform for infra work",
    },
    proposedBy: "user:alice",
  });
  await updateRigChangeStatus(db, workspaceId, verifiedEdit.id, {
    status: "proposed",
    verification: {
      startedAt: new Date(Date.now() - 9 * 60_000).toISOString(),
      finishedAt: new Date(Date.now() - 8 * 60_000).toISOString(),
      passed: true,
      log: "+ starting clean sandbox…\n+ apt-get install -y terraform\n+ running checks…\nterraform version -> ok",
      checkResults: [
        ...passingChecks,
        {
          name: "terraform present",
          command: "terraform version",
          exitCode: 0,
          output: "Terraform v1.9.5",
        },
      ],
    },
  });

  // e) A change whose verification itself errored (infra failure).
  const failed = await createRigChange(db, {
    ...ws,
    rigId: dev.id,
    baseVersionId: activeVersion.id,
    kind: "setup_append",
    payload: { command: "apt-get install -y heavy-package" },
    proposedBy: "user:you",
  });
  await updateRigChangeStatus(db, workspaceId, failed.id, {
    status: "failed",
    verification: {
      startedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      finishedAt: new Date(Date.now() - 39 * 60_000).toISOString(),
      log: "+ pulling image…\nsandbox provisioning error: image pull timed out after 600s",
    },
  });

  // f) A fresh proposal not yet verified.
  await createRigChange(db, {
    ...ws,
    rigId: dev.id,
    baseVersionId: activeVersion.id,
    kind: "definition_edit",
    payload: { image: "ghcr.io/opengeni/dev:2026-07", changelog: "Try the July base image" },
    proposedBy: "session:2b3c4d5e-6f70-8192-a3b4-c5d6e7f8091a",
  });

  // 3) A CI runner rig with checks that have never been verified (unknown health).
  await createRig(db, {
    ...ws,
    name: "ci-runner",
    description: "Ephemeral executor for the CI pipeline.",
    createdBy: "system",
    initialVersion: {
      image: "ghcr.io/opengeni/ci:base",
      setupScript: "apt-get install -y make gcc",
      checks: [
        { name: "make present", command: "make --version" },
        { name: "gcc present", command: "gcc --version" },
      ],
      changelog: "Initial CI runner",
      createdBy: "system",
    },
  });

  // 4) A rig whose active version's most recent re-verify FAILED — a check that
  //    used to pass regressed (the self-healing narrative). The active-version
  //    health derives from a `rig.verification.failed` audit row (list card dot).
  const legacy = await createRig(db, {
    ...ws,
    name: "legacy-box",
    description: "Older toolchain kept for the reporting pipeline.",
    createdBy: "user:you",
    initialVersion: {
      image: "ghcr.io/opengeni/legacy:base",
      setupScript: "apt-get install -y python2 make",
      checks: [
        { name: "python2 present", command: "python2 --version" },
        { name: "make present", command: "make --version" },
      ],
      changelog: "Initial legacy box",
      createdBy: "user:you",
    },
  });
  const legacyVersions = await listRigVersions(db, workspaceId, legacy.id);
  const legacyActive = legacyVersions.find((version) => version.active) ?? legacyVersions[0]!;
  await recordAuditEvent(db, {
    accountId,
    workspaceId,
    action: "rig.verification.failed",
    targetType: "rig",
    targetId: legacy.id,
    metadata: {
      versionId: legacyActive.id,
      passed: false,
      finishedAt: new Date(Date.now() - 90_000).toISOString(),
    },
  });

  // The workspace default rig: new sessions materialize from it unless the
  // composer picks another. Drives the "Default" badge + set/clear control.
  await setWorkspaceDefaultRig(db, workspaceId, dev.id);
}

main().catch(async (error) => {
  console.error("[rig-ui] fatal:", error);
  await web?.stop().catch(() => undefined);
  await api?.stop().catch(() => undefined);
  await services?.down().catch(() => undefined);
  process.exit(1);
});

process.on("exit", () => {
  void web?.stop();
  void api?.stop();
  void services?.down();
});
