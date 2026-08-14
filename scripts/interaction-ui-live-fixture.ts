import { OpenGeniClient } from "@opengeni/sdk";

export type InteractionUiFixture = {
  client: OpenGeniClient;
  workspaceId: string;
  sessionId: string;
  browserSessionId: string;
  computerSessionId: string;
  dispose(): Promise<void>;
};

export async function createInteractionUiFixture(): Promise<InteractionUiFixture> {
  const apiUrl = new URL(process.env.OPENGENI_INTERACTION_UI_API_URL ?? "http://127.0.0.1:8200")
    .origin;
  const accessKey = process.env.OPENGENI_INTERACTION_ACCEPTANCE_ACCESS_KEY?.trim();
  const client = new OpenGeniClient({
    baseUrl: apiUrl,
    ...(accessKey ? { headers: { "x-opengeni-access-key": accessKey } } : {}),
  });
  const workspaceId =
    process.env.OPENGENI_INTERACTION_UI_WORKSPACE_ID?.trim() || (await defaultWorkspace(apiUrl));
  const runId = crypto.randomUUID();
  const session = await client.createSession(workspaceId, {
    startMode: "realtime",
    sandboxBackend: "modal",
    sandbox: "new",
    rigId: null,
    idempotencyKey: `interaction-ui-live:${runId}`,
    metadata: { origin: "interaction-ui-live-fixture", runId },
  });
  const computer = await client.interaction.computers.open(workspaceId, {
    operationId: crypto.randomUUID(),
    sessionId: session.id,
    name: "UI acceptance computer",
  });
  const computerState = await computer.get();
  const browser = await client.interaction.browsers.open(workspaceId, {
    operationId: crypto.randomUUID(),
    sessionId: session.id,
    name: "UI acceptance browser",
    initialUrl: fixtureUrl(),
    headless: false,
    linkedComputerSessionId: computer.id,
    placement: computerState.placement,
  });
  return {
    client,
    workspaceId,
    sessionId: session.id,
    browserSessionId: browser.id,
    computerSessionId: computer.id,
    dispose: async () => {
      // A linked browser is a live holder of its computer. Release it first so
      // cleanup cannot race the computer end against that ownership edge and
      // silently leave the desktop running after an acceptance process exits.
      await browser.end({ operationId: crypto.randomUUID() }).catch(() => undefined);
      await computer.end({ operationId: crypto.randomUUID() }).catch(() => undefined);
    },
  };
}

if (import.meta.main) {
  const fixture = await createInteractionUiFixture();
  process.stdout.write(
    `${JSON.stringify({ status: "ready", workspaceId: fixture.workspaceId, sessionId: fixture.sessionId, browserSessionId: fixture.browserSessionId, computerSessionId: fixture.computerSessionId })}\n`,
  );

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await fixture.dispose();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  await new Promise(() => undefined);
}

async function defaultWorkspace(apiUrl: string): Promise<string> {
  const response = await fetch(new URL("/v1/access/me", apiUrl));
  if (!response.ok) throw new Error(`access discovery returned ${response.status}`);
  const value = (await response.json()) as { defaultWorkspaceId?: unknown };
  if (typeof value.defaultWorkspaceId !== "string" || !value.defaultWorkspaceId) {
    throw new Error("access discovery did not return a default workspace");
  }
  return value.defaultWorkspaceId;
}

function fixtureUrl(): string {
  const html = `<!doctype html><meta charset="utf-8"><title>OpenGeni UI acceptance</title><style>body{font:24px system-ui;background:#10151d;color:#fff;margin:0}h1{margin:32px}label{position:fixed;left:10%;top:18%;width:80%;height:45%}input{box-sizing:border-box;display:block;font:24px system-ui;margin-top:12px;padding:16px;width:100%;height:80%}#state{position:fixed;left:10%;top:72%;width:80%;overflow-wrap:anywhere}</style><h1>UI acceptance</h1><label>Acceptance input<input id="acceptance-input" aria-label="Acceptance input" autofocus></label><div id="state">ready</div><script>const input=document.querySelector("#acceptance-input");const state=document.querySelector("#state");input.addEventListener("input",()=>{state.textContent=input.value;document.title="UI "+input.value.slice(-24)})</script>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
