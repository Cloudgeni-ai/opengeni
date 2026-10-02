// Actual Vue SFC browser acceptance with synthetic API/SSE fixtures only.
import { chromium, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import type { Session, SessionEvent, SessionHumanInputRequest } from "@opengeni/sdk";

const output =
  process.env.VUE_PREVIEW_OUTPUT ??
  (existsSync("/workspace/.opengeni") ? "/workspace/previews" : join(process.cwd(), "previews"));
const executablePath =
  process.env.VUE_CHROMIUM ??
  (existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : undefined);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const ws = "fixture-workspace";
let session = {
  id: "fixture-session",
  workspaceId: ws,
  title: "A quiet afternoon by the water",
  initialMessage: "We have a free afternoon. What would you suggest?",
  status: "idle",
  effectiveControl: { state: "active" },
} as Session;
let history: SessionEvent[] = [];
let requests: SessionHumanInputRequest[] = [];
let authenticated = true;
let failSend = false;
let lastCreation: unknown;
const sendIds: string[] = [];
function append(type: SessionEvent["type"], payload: unknown) {
  const event: SessionEvent = {
    id: `event-${history.length + 1}`,
    workspaceId: ws,
    sessionId: session.id,
    sequence: history.length + 1,
    type,
    payload,
    turnId: "fixture-turn",
    occurredAt: "2026-10-01T12:00:00Z",
  };
  history.push(event);
  session.lastSequence = event.sequence;
  return event;
}
append("user.message", { text: session.initialMessage });
append("agent.message.delta", { text: "Start with a stroll", messageId: "reply-1" });
append("agent.message.completed", {
  text: "Start with a stroll along the waterfront, then find a sunny table for lunch.\n\nIf you would rather stay indoors, a small local museum makes a relaxed alternative. Tell me what kind of afternoon you have in mind and I can help you sketch a plan.",
  messageId: "reply-1",
});
append("turn.completed", {});

await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (path === "/api/demo-login") {
    authenticated = true;
    return route.fulfill({ json: {} });
  }
  if (path === "/api/context")
    return route.fulfill({
      status: authenticated ? 200 : 401,
      json: { workspaceId: ws, storageScope: "fixture-tenant:fixture-user", csrf: "fixture-csrf" },
    });
  if (!authenticated) return route.fulfill({ status: 401, json: { message: "unauthenticated" } });
  if (request.method() === "POST") {
    assert.equal(request.headers()["x-host-csrf"], "fixture-csrf");
    assert.equal(
      request.headers()["authorization"],
      undefined,
      "No organization key may reach the browser",
    );
  }
  if (path.endsWith("/events/stream")) {
    const after = Number(url.searchParams.get("after") ?? 0);
    const body =
      history
        .filter((event) => event.sequence > after)
        .map((event) => `id: ${event.sequence}\nevent: session\ndata: ${JSON.stringify(event)}\n\n`)
        .join("") || ": heartbeat\n\n";
    return route.fulfill({ contentType: "text/event-stream", body });
  }
  if (path.endsWith("/events") && request.method() === "GET") {
    return route.fulfill({
      json: history.filter((event) => event.sequence > Number(url.searchParams.get("after") ?? 0)),
    });
  }
  if (path.endsWith("/human-input-requests")) return route.fulfill({ json: { requests } });
  if (path.endsWith("/sessions") && request.method() === "GET")
    return route.fulfill({ json: { sessions: [session], pinned: [], nextCursor: null } });
  if (path.endsWith("/sessions") && request.method() === "POST") {
    lastCreation = request.postDataJSON();
    const body = lastCreation as { initialMessage: string };
    session = {
      ...session,
      id: "new-fixture-session",
      initialMessage: body.initialMessage,
      title: "A new plan",
    };
    history = [];
    append("user.message", { text: body.initialMessage });
    append("agent.message.completed", {
      text: "Let's plan something comfortable for tomorrow.",
      messageId: "reply-new",
    });
    return route.fulfill({ json: session });
  }
  if (path.endsWith("/control") && request.method() === "POST") {
    const body = request.postDataJSON();
    session = {
      ...session,
      effectiveControl: {
        ...session.effectiveControl,
        state: body.action === "pause" ? "paused" : "active",
      },
    };
    append(body.action === "pause" ? "session.control.paused" : "session.control.resumed", {});
    return route.fulfill({
      json: { sessionId: session.id, effectiveControl: session.effectiveControl },
    });
  }
  if (path.endsWith("/events") && request.method() === "POST") {
    const input = request.postDataJSON();
    if (input.type === "user.message") {
      sendIds.push(input.clientEventId);
      if (failSend)
        return route.fulfill({
          status: 503,
          json: {
            code: "upstream_unavailable",
            message: "OpenGeni diagnostic must not leak",
            retryable: false,
            outcomeUnknown: true,
          },
        });
    }
    const accepted = append(input.type, input.payload);
    if (input.type === "user.message")
      append("agent.message.completed", {
        text: "A relaxed start sounds good. Leave time for a coffee by the water.",
        messageId: crypto.randomUUID(),
      });
    if (input.type === "user.humanInputResponse") {
      requests = [];
      session.status = "idle";
    }
    return route.fulfill({ json: accepted });
  }
  if (path.includes("/sessions/")) return route.fulfill({ json: session });
  throw new Error(`Unhandled fixture route ${request.method()} ${path}`);
});

async function visible(text: string) {
  await page.getByText(text, { exact: false }).first().waitFor();
}
async function screenshot(name: string) {
  await page.screenshot({ path: join(output, name), fullPage: true });
}
async function noBranding(target: Page) {
  assert(
    !/opengeni/i.test(await target.locator("body").innerText()),
    "Host UI must not expose provider branding",
  );
}

try {
  await page.goto(process.env.VUE_PREVIEW_URL ?? "http://127.0.0.1:3104");
  await visible("Start with a stroll along the waterfront");
  await noBranding(page);
  await screenshot("harbor-vue-desktop.png");
  await page.reload();
  await visible("Start with a stroll along the waterfront");
  assert.equal(
    await page.locator(".message.assistant").count(),
    1,
    "Replay must not duplicate completed text",
  );

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
  await visible("Messages are saved in the queue");
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).waitFor();

  failSend = true;
  await page.getByLabel("Message the guest desk").fill("Could we start later?");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Retry saved message" }).waitFor();
  await noBranding(page);
  await page.reload();
  await page.getByRole("button", { name: "Retry saved message" }).waitFor();
  failSend = false;
  await page.getByRole("button", { name: "Retry saved message" }).click();
  await visible("A relaxed start sounds good.");
  assert.equal(new Set(sendIds).size, 1, "Retry after reload must reuse the saved clientEventId");

  session.status = "requires_action";
  append("session.requiresAction", {
    approvals: [
      {
        id: "booking-call",
        name: "Request a table for two",
        arguments: { time: "13:00", guests: 2 },
      },
    ],
  });
  requests = [
    {
      id: "input-1",
      status: "pending",
      allowSkip: true,
      expiresAt: null,
      questions: [
        {
          id: "pace",
          kind: "text",
          prompt: "What pace would you prefer?",
          required: true,
          allowOther: false,
          options: [],
        },
        {
          id: "place",
          kind: "single_select",
          prompt: "Where would you like to start?",
          required: true,
          allowOther: true,
          options: [
            { id: "waterfront", label: "Waterfront" },
            { id: "museum", label: "Museum" },
          ],
        },
        {
          id: "extras",
          kind: "multi_select",
          prompt: "Anything to include?",
          required: false,
          allowOther: true,
          options: [
            { id: "coffee", label: "Coffee" },
            { id: "garden", label: "Garden" },
          ],
          validation: { minSelections: 0, maxSelections: 2 },
        },
      ],
    },
  ] as SessionHumanInputRequest[];
  append("session.humanInput.requested", { requestId: "input-1" });
  await visible("Allow this action?");
  await visible("What pace would you prefer?");
  await screenshot("harbor-vue-decisions.png");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("heading", { name: "Allow this action?" }).waitFor({ state: "hidden" });
  await page.getByRole("textbox", { name: "What pace would you prefer?" }).fill("Relaxed");
  await page
    .getByRole("combobox", { name: "Where would you like to start?" })
    .selectOption("waterfront");
  await page
    .getByRole("listbox", { name: "Anything to include?" })
    .selectOption(["coffee", "garden"]);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("heading", { name: "A detail before we continue" })
    .waitFor({ state: "hidden" });
  await page.reload();
  await visible("A relaxed start sounds good.");
  assert.equal(
    await page.getByRole("heading", { name: "Allow this action?" }).count(),
    0,
    "Answered approval must not reappear after replay",
  );

  await page.getByRole("button", { name: "New conversation" }).click();
  await page.getByLabel("Message the guest desk").fill("Help me plan tomorrow.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await visible("Let's plan something comfortable for tomorrow.");
  assert.deepEqual(
    Object.keys(lastCreation as object).sort(),
    ["idempotencyKey", "initialMessage"],
    "Browser creation cannot choose model/tools/tenant",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot("harbor-vue-mobile.png");
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "Mobile layout must not overflow horizontally",
  );
  await noBranding(page);
  authenticated = false;
  await page.reload();
  await page.getByRole("button", { name: "Sign in to local demo" }).waitFor();
  assert.equal(
    await page.locator(".message").count(),
    0,
    "Expired sign-in must clear the previous user's UI",
  );
  await page.getByRole("button", { name: "Sign in to local demo" }).click();
  await visible("Let's plan something comfortable for tomorrow.");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: actual Vue desktop/mobile, replay/reload, create/send, saved-id retry after reload, pause/resume, approval, text/single/multi input, sign-in expiry and no host branding leaks. Synthetic service fixtures only.",
  );
  console.log(`Screenshots: ${output}/harbor-vue-{desktop,decisions,mobile}.png`);
} finally {
  await browser.close();
}
