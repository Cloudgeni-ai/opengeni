/**
 * A stand-in for pass-cli 2.4.2 used by the adapter tests. It reproduces the
 * argv grammar, JSON output shapes, stdout lines and anyhow-style stderr of the
 * real CLI (pass-cli v2.4.2 source: commands/item/*, share/list.rs, info.rs,
 * main.rs) over a JSON state file, and logs each invocation without secrets.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type FakeAttachment = {
  id: string;
  size: number;
  content: { name: string; mime_type: string };
  /** base64 bytes */
  data: string;
};

export type FakeFailure = {
  /** Substring of the joined argv that triggers the failure. */
  match: string;
  stderr?: string;
  exitCode?: number;
  sleepMs?: number;
  stdoutBytes?: number;
  /** Apply the mutation before failing (an error after the request was sent). */
  afterEffect?: boolean;
  once?: boolean;
};

export type FakeState = {
  version: string;
  token: string;
  tokenName: string;
  agent: boolean;
  shares: Array<{ id: string; name: string; share_type: string; share_role: unknown }>;
  items: Record<string, Array<Record<string, unknown>>>;
  attachments: Record<string, FakeAttachment[]>;
  failures: FakeFailure[];
  /** Number of upcoming commands that report an invalidated session. */
  invalidate?: number;
  logins?: number;
};

const statePath = process.env.FAKE_PASS_STATE!;
const logPath = `${statePath}.log`;
const argv = process.argv.slice(2);
const joined = argv.join(" ");

function load(): FakeState {
  return JSON.parse(readFileSync(statePath, "utf8")) as FakeState;
}
function save(state: FakeState) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}
function fail(context: string, cause?: string, code = 1): never {
  process.stderr.write(
    cause ? `Error: ${context}\n\nCaused by:\n    ${cause}\n` : `Error: ${context}\n`,
  );
  process.exit(code);
}
function option(name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === `--${name}`) return argv[index + 1];
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return undefined;
}
function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
function civilNow(): string {
  return new Date().toISOString().slice(0, 19);
}

const stdin = argv.includes("-") ? readStdin() : "";
const env = process.env;
appendFileSync(
  logPath,
  `${JSON.stringify({
    argv,
    envNames: Object.keys(env)
      .filter((name) => name !== "FAKE_PASS_STATE")
      .sort(),
    home: env.HOME,
    sessionDir: env.PROTON_PASS_SESSION_DIR,
    path: env.PATH,
    reason: env.PROTON_PASS_AGENT_REASON ?? null,
    patPresent: env.PROTON_PASS_PERSONAL_ACCESS_TOKEN !== undefined,
    stdin,
  })}\n`,
);

const state = load();

if (argv[0] === "--version") {
  console.log(`Proton Pass CLI ${state.version} (0a1b2c3)`);
  process.exit(0);
}

// Failure injection.
const failureIndex = state.failures.findIndex((failure) => joined.includes(failure.match));
const failure = failureIndex >= 0 ? state.failures[failureIndex] : undefined;
if (failure?.once) {
  state.failures.splice(failureIndex, 1);
  save(state);
}
if (failure?.sleepMs) await new Promise((resolve) => setTimeout(resolve, failure.sleepMs));
if (failure?.stdoutBytes) {
  process.stdout.write("x".repeat(failure.stdoutBytes));
  process.exit(0);
}
if (failure && !failure.afterEffect && failure.stderr !== undefined) {
  process.stderr.write(failure.stderr);
  process.exit(failure.exitCode ?? 1);
}

const sessionDir = env.PROTON_PASS_SESSION_DIR!;
const sessionFile = join(sessionDir, "session.json");
const keyDigest = createHash("sha256")
  .update(env.PROTON_PASS_ENCRYPTION_KEY ?? "")
  .digest("hex");

if (argv[0] === "login") {
  if (env.PROTON_PASS_KEY_PROVIDER !== "env" || !env.PROTON_PASS_ENCRYPTION_KEY) {
    fail("Error getting key provider", "PROTON_PASS_ENCRYPTION_KEY must be set");
  }
  if (env.PROTON_PASS_PERSONAL_ACCESS_TOKEN !== state.token) {
    fail("Error logging in with personal access token", "Invalid status code: 422");
  }
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(sessionFile, JSON.stringify({ keyDigest }));
  state.logins = (state.logins ?? 0) + 1;
  save(state);
  console.log(`Successfully logged in as personal access token: ${state.tokenName}`);
  process.exit(0);
}

if (argv[0] === "logout") {
  rmSync(sessionDir, { recursive: true, force: true });
  console.log("Successfully logged out");
  process.exit(0);
}

if (
  !existsSync(sessionFile) ||
  JSON.parse(readFileSync(sessionFile, "utf8")).keyDigest !== keyDigest
) {
  fail("This operation requires an authenticated client");
}
if (state.invalidate && state.invalidate > 0) {
  state.invalidate -= 1;
  save(state);
  process.stderr.write(
    "Your session has been invalidated and you have been logged out automatically.\nPlease log in again with: pass login\n",
  );
  process.exit(1);
}

function requireReason() {
  if (!state.agent) return;
  if (!env.PROTON_PASS_AGENT_REASON) {
    fail(
      "Agent sessions must set the PROTON_PASS_AGENT_REASON environment variable before running commands.",
    );
  }
}

function shareRole(shareId: string): unknown {
  const share = state.shares.find((candidate) => candidate.id === shareId);
  if (!share) fail("Error retrieving item", `Share with id ${shareId} not found`);
  return share.share_role;
}

function findItem(shareId: string, itemId: string) {
  shareRole(shareId);
  const item = (state.items[shareId] ?? []).find((candidate) => candidate.id === itemId);
  return item;
}

const [command, sub, third] = argv;

if (command === "info") {
  console.log(
    JSON.stringify({
      release_track: "stable",
      id: "N/A",
      personal_access_token_name: `${state.agent ? "[Agent] " : ""}${state.tokenName}`,
      session_has_lock: false,
    }),
  );
  process.exit(0);
}

if (command === "share" && sub === "list") {
  console.log(JSON.stringify({ shares: state.shares }, null, 2));
  process.exit(0);
}

if (command === "vault" && sub === "list") {
  console.log(
    JSON.stringify({
      vaults: state.shares.map((share) => ({
        name: share.name,
        vault_id: `v-${share.id}`,
        share_id: share.id,
      })),
    }),
  );
  process.exit(0);
}

if (command === "item" && sub === "list") {
  const shareId = option("share-id")!;
  if (argv.includes("--show-secrets") && state.agent) {
    fail("--show-secrets is not allowed with an agent session");
  }
  shareRole(shareId);
  let items = state.items[shareId] ?? [];
  if (option("filter-state") === "active") items = items.filter((item) => item.state === "Active");
  const out = argv.includes("--show-secrets")
    ? items
    : items.map((item) => {
        const content = item.content as {
          title: string;
          content: Record<string, unknown> | string;
        };
        const variant =
          typeof content.content === "string" ? content.content : Object.keys(content.content)[0]!;
        const snake = variant.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
        return {
          id: item.id,
          share_id: item.share_id,
          vault_id: item.vault_id,
          state: item.state,
          flags: item.flags,
          create_time: item.create_time,
          modify_time: item.modify_time,
          title: content.title,
          item_type: snake,
        };
      });
  console.log(JSON.stringify({ items: out }, null, 2));
  process.exit(0);
}

if (command === "item" && sub === "view") {
  requireReason();
  const shareId = option("share-id")!;
  const item = findItem(shareId, option("item-id")!);
  if (!item) fail("Error retrieving item", "Item not found");
  const attachments = (state.attachments[item.id as string] ?? []).map(
    ({ data: _data, ...rest }) => ({
      ...rest,
      encryption_version: 1,
      chunks: [{ id: "c1", size: rest.size, index: 0 }],
      encrypted_file_key: "AAAA",
    }),
  );
  console.log(JSON.stringify({ item, attachments }, null, 2));
  process.exit(0);
}

if (command === "item" && sub === "create") {
  requireReason();
  const shareId = option("share-id")!;
  const role = shareRole(shareId);
  const kind = third!;
  const context = `Error creating ${kind} item`;
  let template: Record<string, unknown>;
  try {
    template = JSON.parse(stdin) as Record<string, unknown>;
  } catch {
    fail("Error parsing JSON from stdin", "expected value at line 1 column 1");
  }
  if (role === "Viewer") fail(context, "Could not perform operation. Reason: PermissionDenied");
  const id = randomBytes(12).toString("base64url");
  const now = civilNow();
  let content: unknown;
  let note = "";
  let extra: unknown[] = [];
  if (kind === "login") {
    content = {
      Login: {
        email: template.email ?? "",
        username: template.username ?? "",
        password: template.password ?? "",
        urls: template.urls ?? [],
        totp_uri: template.totp_uri ?? "",
        passkeys: [],
        autofill_urls: [],
      },
    };
  } else if (kind === "note") {
    content = { Note: null };
    note = (template.note as string | null) ?? "";
  } else if (kind === "custom") {
    note = (template.note as string | null) ?? "";
    const sections =
      (template.sections as Array<{
        section_name: string;
        fields: Array<{ field_name: string; field_type: string; value: string }>;
      }>) ?? [];
    content = {
      Custom: {
        sections: sections.map((section) => ({
          section_name: section.section_name,
          section_fields: section.fields.map((field) => {
            const type = field.field_type.toLowerCase();
            if (type === "text") return { name: field.field_name, content: { Text: field.value } };
            if (type === "hidden")
              return { name: field.field_name, content: { Hidden: field.value } };
            if (type === "totp") return { name: field.field_name, content: { Totp: field.value } };
            if (type === "timestamp")
              return { name: field.field_name, content: { Timestamp: Number(field.value) } };
            fail(
              "Error converting template to payload",
              `Invalid field type '${field.field_type}'`,
            );
          }),
        })),
      },
    };
    extra = [];
  } else {
    fail(`unsupported fake create ${kind}`);
  }
  (state.items[shareId] ??= []).push({
    id,
    share_id: shareId,
    vault_id: `v-${shareId}`,
    content: {
      title: template.title,
      note,
      item_uuid: randomBytes(8).toString("hex"),
      content,
      extra_fields: extra,
      platform_specific: null,
      custom_icon: null,
    },
    state: "Active",
    flags: [],
    create_time: now,
    modify_time: now,
  });
  save(state);
  if (failure?.afterEffect) {
    process.stderr.write(failure.stderr ?? "");
    process.exit(failure.exitCode ?? 1);
  }
  console.log(id);
  process.exit(0);
}

if (command === "item" && sub === "trash") {
  requireReason();
  const shareId = option("share-id")!;
  const role = shareRole(shareId);
  const item = findItem(shareId, option("item-id")!);
  if (!item)
    fail(
      "Error trashing item",
      "Error creating trash item request\n\nCaused by:\n    Item not found",
    );
  if (role === "Viewer")
    fail("Error trashing item", "Could not perform operation. Reason: PermissionDenied");
  item.state = "Trashed";
  save(state);
  if (failure?.afterEffect) {
    process.stderr.write(failure.stderr ?? "");
    process.exit(failure.exitCode ?? 1);
  }
  console.log("Item successfully moved to trash");
  process.exit(0);
}

if (command === "item" && sub === "attachment" && third === "download") {
  const shareId = option("share-id")!;
  const itemId = option("item-id")!;
  const attachmentId = option("attachment-id")!;
  const output = option("output")!;
  const item = findItem(shareId, itemId);
  if (!item) fail("Error retrieving item", "Item not found");
  const attachment = (state.attachments[itemId] ?? []).find(
    (candidate) => candidate.id === attachmentId,
  );
  if (!attachment) fail("Attachment not found");
  console.log("Downloading attachment...");
  console.log(`Output path: ${output}`);
  writeFileSync(output, Buffer.from(attachment.data, "base64"));
  console.log("Attachment downloaded successfully");
  process.exit(0);
}

fail(`fake pass-cli does not implement: ${joined}`);
