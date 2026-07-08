/**
 * Tier-1 live wire check using the already-stored ~/.codex/auth.json token.
 * Read-only: never refreshes/mutates auth.json. Verifies, from THIS egress:
 *   [1] GET /codex/models (login check + catalog)
 *   [2] a real streamed /responses turn (the exact normalized body shape)
 *   [3] GET /wham/usage
 *
 *   CODEX_CLIENT_VERSION=<v> bun spikes/codex-subscription/live-token-check.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CODEX_ORIGINATOR,
  CODEX_RESPONSES_BASE,
  fetchCodexModels,
  fetchCodexUsage,
  parseIdToken,
  accessTokenExpiry,
} from "../../packages/codex/src/index";

const CLIENT_VERSION = process.env.CODEX_CLIENT_VERSION ?? "0.142.4";

function loadAuth(): {
  accessToken: string;
  chatgptAccountId: string | null;
  isFedramp: boolean;
  plan: string | null;
} {
  const p = process.env.CODEX_HOME
    ? join(process.env.CODEX_HOME, "auth.json")
    : join(homedir(), ".codex", "auth.json");
  const j = JSON.parse(readFileSync(p, "utf8")) as {
    tokens?: { access_token?: string; id_token?: string; account_id?: string };
  };
  const accessToken = j.tokens?.access_token ?? "";
  const id = parseIdToken(j.tokens?.id_token ?? "");
  const exp = accessTokenExpiry(accessToken);
  if (!exp || exp.getTime() <= Date.now())
    throw new Error("stored access token is expired — refresh via the codex CLI first");
  return {
    accessToken,
    chatgptAccountId: id.chatgptAccountId ?? j.tokens?.account_id ?? null,
    isFedramp: id.isFedramp,
    plan: id.planType,
  };
}

async function streamOneTurn(
  auth: { accessToken: string; chatgptAccountId: string | null; isFedramp: boolean },
  model: string,
): Promise<boolean> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    originator: CODEX_ORIGINATOR,
    "User-Agent": `${CODEX_ORIGINATOR}/${CLIENT_VERSION}`,
    version: CLIENT_VERSION,
    accept: "text/event-stream",
    "content-type": "application/json",
    ...(auth.chatgptAccountId ? { "ChatGPT-Account-ID": auth.chatgptAccountId } : {}),
    ...(auth.isFedramp ? { "X-OpenAI-Fedramp": "true" } : {}),
  };
  const body = {
    model,
    instructions: "You are a helpful assistant.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Reply with exactly: codex-live-ok" }],
      },
    ],
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
  const res = await fetch(`${CODEX_RESPONSES_BASE}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  console.log(`  /responses -> HTTP ${res.status} (${res.headers.get("content-type") ?? "?"})`);
  if (!res.ok || !res.body) {
    console.log("  body:", (await res.text()).slice(0, 800));
    return false;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "",
    text = "";
  const types = new Set<string>();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i = buf.indexOf("\n\n");
    while (i !== -1) {
      const data = buf
        .slice(0, i)
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      buf = buf.slice(i + 2);
      if (data && data !== "[DONE]") {
        try {
          const ev = JSON.parse(data) as { type?: string; delta?: string };
          if (ev.type) types.add(ev.type);
          if (ev.type === "response.output_text.delta" && typeof ev.delta === "string")
            text += ev.delta;
        } catch {
          /* ignore */
        }
      }
      i = buf.indexOf("\n\n");
    }
  }
  console.log(`  event types: ${[...types].join(", ")}`);
  console.log(`  assistant text: ${JSON.stringify(text)}`);
  return text.length > 0;
}

async function main(): Promise<void> {
  const auth = loadAuth();
  console.log(
    `token: plan=${auth.plan} account=${auth.chatgptAccountId?.slice(0, 8)}… clientVersion=${CLIENT_VERSION}`,
  );

  console.log("\n[1/3] GET /codex/models");
  const models = await fetchCodexModels({ ...auth, clientVersion: CLIENT_VERSION });
  console.log(
    `  ok=${models.ok} status=${models.status} slugs=[${models.slugs.slice(0, 14).join(", ")}]`,
  );

  const model = models.slugs.find((s) => /^gpt-5/.test(s)) ?? models.slugs[0] ?? "gpt-5.5";
  console.log(`\n[2/3] streamed /responses on "${model}"`);
  const ok = await streamOneTurn(auth, model);

  console.log("\n[3/3] GET /wham/usage");
  const usage = await fetchCodexUsage({ ...auth, clientVersion: CLIENT_VERSION });
  console.log(`  status=${usage.status} payload=${JSON.stringify(usage.payload)?.slice(0, 500)}`);

  console.log(
    `\nRESULT: models=${models.ok ? "OK" : "FAIL"} responses=${ok ? "OK" : "FAIL"} usage=${usage.status < 500 ? "OK" : "FAIL"}`,
  );
  if (!models.ok || !ok) process.exit(2);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
