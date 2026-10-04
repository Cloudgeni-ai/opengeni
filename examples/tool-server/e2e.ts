import { OpenGeniClient, type SessionEvent } from "@opengeni/sdk";

// Drives the running demo exactly as the browser would: through the proxy,
// signed in as one demo user. `bun run dev` (with a tunnel) must be running.
const user = process.argv[2] ?? "ada";
const workspaceId = process.env.OPENGENI_WORKSPACE_ID!;
const base = `http://localhost:${process.env.PORT ?? 4101}`;
const browser = new OpenGeniClient({
  baseUrl: `${base}/api/opengeni`,
  headers: { "x-demo-user": user },
});

async function settle(sessionId: string, leaving?: string): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const session = await browser.getSession(workspaceId, sessionId);
    if (session.status === leaving) {
      await Bun.sleep(1000);
      continue;
    }
    leaving = undefined;
    if (["idle", "requires_action", "failed", "completed", "cancelled"].includes(session.status)) {
      return session.status;
    }
    await Bun.sleep(2000);
  }
  throw new Error("session did not settle");
}

function summarize(events: SessionEvent[]): void {
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (
      /toolCall|requiresAction|agent\.message\.completed|turn\.(completed|failed)/.test(event.type)
    ) {
      console.log(`  #${event.sequence} ${event.type} ${JSON.stringify(payload).slice(0, 220)}`);
    }
  }
}

const created = (await browser.createSession(workspaceId, {
  initialMessage: "Which of my posts mention launch? Use my posts tools and quote the titles.",
} as never)) as unknown as { id?: string; session?: { id: string } };
const session = { id: (created.session?.id ?? created.id)! };
console.log(`session ${session.id} (user ${user})`);
console.log(`read turn -> ${await settle(session.id)}`);
let events = await browser.listEvents(workspaceId, session.id, {
  after: 0,
  limit: 500,
} as never);
summarize(events);

const seen = events.at(-1)?.sequence ?? 0;
await browser.sendMessage(workspaceId, session.id, {
  text: 'Rename post p1 to "Launch plan v2".',
});
console.log(`write turn -> ${await settle(session.id)}`);
events = await browser.listEvents(workspaceId, session.id, {
  after: seen,
  limit: 500,
} as never);
summarize(events);

const pending = [...events].reverse().find((event) => event.type === "session.requiresAction");
const approval = (pending?.payload as { approvals?: Array<{ id: string; name: string }> })
  ?.approvals?.[0];
if (approval && process.env.APPROVE !== "0") {
  console.log(`approving ${approval.name} (the proxy refreshes the tool token here too)`);
  await browser.sendEvent(workspaceId, session.id, {
    type: "user.approvalDecision",
    clientEventId: crypto.randomUUID(),
    payload: { approvalId: approval.id, decision: "approve" },
  } as never);
  console.log(`after approval -> ${await settle(session.id, "requires_action")}`);
  summarize(
    await browser.listEvents(workspaceId, session.id, {
      after: events.at(-1)!.sequence,
      limit: 500,
    } as never),
  );
}
console.log("posts now:", JSON.stringify(await (await fetch(`${base}/api/posts`)).json()));
