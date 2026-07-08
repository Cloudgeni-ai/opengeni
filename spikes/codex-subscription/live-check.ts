/**
 * Phase-0 live check for the Codex subscription integration.
 *
 * Run from the SAME egress your worker/api use (this is what's genuinely
 * unverified: whether Cloudflare/TLS lets a datacenter IP through, whether the
 * client version is accepted, and whether the streamed /responses body is taken):
 *
 *   bun spikes/codex-subscription/live-check.ts
 *
 * It does device-code login (prints a code + URL for you to authorize in a
 * browser), then: (1) GET /codex/models — the login check, (2) a real streamed
 * /responses turn, (3) GET /wham/usage. No database, no agent — pure wire check.
 */

import {
  CODEX_CLIENT_VERSION,
  CODEX_ORIGINATOR,
  CODEX_RESPONSES_BASE,
  exchangeDeviceCode,
  fetchCodexModels,
  fetchCodexUsage,
  parseIdToken,
  pollDeviceCode,
  startDeviceCode,
  accessTokenExpiry,
} from "@opengeni/codex";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function login(): Promise<{
  accessToken: string;
  chatgptAccountId: string | null;
  isFedramp: boolean;
  plan: string | null;
}> {
  const start = await startDeviceCode();
  console.log(`\n  1. Open: ${start.verificationUri}`);
  console.log(`  2. Enter code: ${start.userCode}\n  (polling every ${start.intervalSeconds}s)`);
  for (;;) {
    await sleep(start.intervalSeconds * 1000);
    const poll = await pollDeviceCode({
      deviceAuthId: start.deviceAuthId,
      userCode: start.userCode,
    });
    if (poll.status === "pending") {
      process.stdout.write(".");
      continue;
    }
    if (poll.status === "expired") throw new Error("device code expired — re-run");
    const tokens = await exchangeDeviceCode({
      authorizationCode: poll.authorizationCode,
      codeVerifier: poll.codeVerifier,
    });
    const id = parseIdToken(tokens.idToken);
    console.log(
      `\n  ✓ logged in — plan=${id.planType ?? "?"} account=${id.chatgptAccountId ?? "?"} exp=${accessTokenExpiry(tokens.accessToken)?.toISOString() ?? "?"}`,
    );
    return {
      accessToken: tokens.accessToken,
      chatgptAccountId: id.chatgptAccountId,
      isFedramp: id.isFedramp,
      plan: id.planType,
    };
  }
}

async function streamOneTurn(
  auth: { accessToken: string; chatgptAccountId: string | null; isFedramp: boolean },
  model: string,
): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    originator: CODEX_ORIGINATOR,
    "User-Agent": `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION}`,
    version: CODEX_CLIENT_VERSION,
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
    console.log("  body:", (await res.text()).slice(0, 600));
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  const types = new Set<string>();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i = buf.indexOf("\n\n");
    while (i !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
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
  console.log(`  event types seen: ${[...types].join(", ")}`);
  console.log(`  assistant text: ${JSON.stringify(text)}`);
}

async function main(): Promise<void> {
  const auth = await login();

  console.log("\n[1/3] GET /codex/models (login check + live catalog)");
  const models = await fetchCodexModels({ ...auth, clientVersion: CODEX_CLIENT_VERSION });
  console.log(
    `  ok=${models.ok} status=${models.status} slugs=${models.slugs.slice(0, 12).join(", ")}${models.slugs.length > 12 ? " …" : ""}`,
  );

  const model = models.slugs[0] ?? "gpt-5.5";
  console.log(`\n[2/3] streamed /responses on model "${model}"`);
  await streamOneTurn(auth, model);

  console.log("\n[3/3] GET /wham/usage");
  const usage = await fetchCodexUsage({ ...auth, clientVersion: CODEX_CLIENT_VERSION });
  console.log(`  status=${usage.status} payload=${JSON.stringify(usage.payload)?.slice(0, 600)}`);

  console.log(
    "\nDone. If [1] is 200, [2] streamed text, and [3] returned a body, the wire path works from this egress.",
  );
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
