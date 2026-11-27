import { expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";
import {
  createAiConsentGate,
  isAiConsentRequired,
  watchAiConsentRefusals,
  type AiConsentApi,
  type AiConsentStatus,
} from "./ai-consent-gate";

const V1 = "a".repeat(64);
const V2 = "b".repeat(64);

function consentStatus(version: string, granted: boolean): AiConsentStatus {
  return {
    required: !granted,
    disclosure: {
      version,
      title: "Allow sharing with AI providers?",
      body: `Text ${version.slice(0, 1)}`,
      providers: ["OpenAI"],
      privacyUrl: "https://example.com/privacy",
    },
    consent: granted ? { version, grantedAt: "2026-11-26T17:00:00.000Z", platform: "ios" } : null,
  };
}

function apiError(status: number, code?: string): OpenGeniApiError {
  return new OpenGeniApiError(
    status,
    JSON.stringify({
      error: { code: "x", message: "Refused.", ...(code ? { details: { code } } : {}) },
    }),
    { mutation: true },
  );
}

function server(initial: { version: string; granted: boolean }) {
  const state = { ...initial, reads: 0, grants: [] as string[], refuseGrantOnce: false };
  const api: AiConsentApi = {
    read: async () => {
      state.reads++;
      return consentStatus(state.version, state.granted);
    },
    grant: async (version) => {
      state.grants.push(version);
      if (state.refuseGrantOnce) {
        state.refuseGrantOnce = false;
        throw apiError(500);
      }
      if (version !== state.version) throw apiError(409, "ai_processing_consent_version_mismatch");
      state.granted = true;
      return consentStatus(state.version, true);
    },
    withdraw: async () => {
      state.granted = false;
      return consentStatus(state.version, false);
    },
  };
  return { state, api };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("with permission already given, Send goes ahead and later checks need no request", async () => {
  const { state, api } = server({ version: V1, granted: true });
  const gate = createAiConsentGate(api);
  expect(await gate.ensure()).toBe(true);
  expect(await gate.ensure()).toBe(true);
  expect(state.reads).toBe(1);
  expect(gate.snapshot().prompt).toBeNull();
});

test("without it, the server's text is shown and nothing goes ahead until Allow", async () => {
  const { state, api } = server({ version: V1, granted: false });
  const gate = createAiConsentGate(api);
  let result: boolean | undefined;
  void gate.ensure().then((value) => (result = value));
  await tick();
  expect(gate.snapshot().prompt).toMatchObject({
    disclosure: { version: V1, title: "Allow sharing with AI providers?", providers: ["OpenAI"] },
    changed: false,
  });
  expect(result).toBeUndefined();
  // A second action while the question is open waits on the same answer.
  const second = gate.ensure();
  gate.allow();
  await tick();
  expect(result).toBe(true);
  expect(await second).toBe(true);
  expect(state.grants).toEqual([V1]);
  expect(gate.snapshot().prompt).toBeNull();
  expect(gate.snapshot().status?.consent?.version).toBe(V1);
});

test("Not now sends nothing and grants nothing", async () => {
  const { state, api } = server({ version: V1, granted: false });
  const gate = createAiConsentGate(api);
  const answer = gate.ensure();
  await tick();
  gate.dismiss();
  expect(await answer).toBe(false);
  expect(state.grants).toEqual([]);
  // The next action asks again.
  const again = gate.ensure();
  await tick();
  expect(gate.snapshot().prompt).not.toBeNull();
  gate.dismiss();
  expect(await again).toBe(false);
});

test("text that changed while it was open is shown again and never accepted for the person", async () => {
  const { state, api } = server({ version: V1, granted: false });
  const gate = createAiConsentGate(api);
  const answer = gate.ensure();
  await tick();
  state.version = V2;
  gate.allow();
  await tick();
  await tick();
  expect(state.granted).toBe(false);
  expect(gate.snapshot().prompt).toMatchObject({ disclosure: { version: V2 }, changed: true });
  gate.allow();
  expect(await answer).toBe(true);
  expect(state.grants).toEqual([V1, V2]);
});

test("a failed grant stays on the question with a reason, and Allow can try again", async () => {
  const { state, api } = server({ version: V1, granted: false });
  state.refuseGrantOnce = true;
  const gate = createAiConsentGate(api);
  const answer = gate.ensure();
  await tick();
  gate.allow();
  await tick();
  expect(gate.snapshot().prompt).toMatchObject({ granting: false });
  expect(gate.snapshot().prompt?.error).toContain("Try again");
  gate.allow();
  expect(await answer).toBe(true);
});

test("a server refusal for want of permission asks again, even after it was given", async () => {
  const { state, api } = server({ version: V1, granted: true });
  const gate = createAiConsentGate(api);
  expect(await gate.ensure()).toBe(true);
  // Withdrawn on another device: the cached answer is out of date.
  state.granted = false;
  const refusal = apiError(403, "ai_processing_consent_required");
  expect(isAiConsentRequired(refusal)).toBe(true);
  expect(isAiConsentRequired(apiError(403))).toBe(false);
  const asked = gate.refused();
  // The caller retrying its Send joins the same question.
  const retry = gate.refused();
  await tick();
  expect(gate.snapshot().prompt).not.toBeNull();
  gate.allow();
  expect(await asked).toBe(true);
  expect(await retry).toBe(true);
  expect(state.granted).toBe(true);
});

test("a deployment without consent asks nothing; an unreadable answer is not remembered", async () => {
  const old = createAiConsentGate({
    read: async () => {
      throw apiError(404);
    },
    grant: async () => consentStatus(V1, true),
    withdraw: async () => consentStatus(V1, false),
  });
  expect(await old.ensure()).toBe(true);
  expect(old.snapshot().supported).toBe(false);

  let reads = 0;
  const offline = createAiConsentGate({
    read: async () => {
      reads++;
      throw new TypeError("Network request failed");
    },
    grant: async () => consentStatus(V1, true),
    withdraw: async () => consentStatus(V1, false),
  });
  // The server still refuses without permission, and that refusal asks.
  expect(await offline.ensure()).toBe(true);
  expect(await offline.ensure()).toBe(true);
  expect(reads).toBe(2);
});

test("Settings withdraws and grants the text it shows", async () => {
  const { state, api } = server({ version: V1, granted: true });
  const gate = createAiConsentGate(api);
  await gate.refresh();
  await gate.withdraw();
  expect(state.granted).toBe(false);
  expect(gate.snapshot().status?.required).toBe(true);
  state.version = V2;
  // The shown text is out of date: nothing is granted, and the new text is read.
  expect(await gate.grantShown()).toBe(false);
  expect(state.granted).toBe(false);
  expect(gate.snapshot().status?.disclosure.version).toBe(V2);
  expect(await gate.grantShown()).toBe(true);
  expect(state.granted).toBe(true);
});

test("closing for another account answers an open question with Not now", async () => {
  const { api } = server({ version: V1, granted: false });
  const gate = createAiConsentGate(api);
  const answer = gate.ensure();
  await tick();
  gate.close();
  expect(await answer).toBe(false);
  expect(await gate.ensure()).toBe(false);
});

test("any request the server refuses for want of permission is noticed, its response untouched", async () => {
  let refusals = 0;
  const respond = (status: number, body: string) => async () => new Response(body, { status });
  const refused = JSON.stringify({
    error: {
      code: "forbidden",
      message: "No.",
      details: { code: "ai_processing_consent_required" },
    },
  });
  const watched = watchAiConsentRefusals(respond(403, refused), () => refusals++);
  const response = await watched("https://example.com/v1/workspaces/w/transcriptions");
  expect(await response.text()).toBe(refused);
  await tick();
  expect(refusals).toBe(1);
  // Other refusals and other answers are not this one.
  await watchAiConsentRefusals(
    respond(403, '{"error":{"code":"forbidden"}}'),
    () => refusals++,
  )("https://example.com/x");
  await watchAiConsentRefusals(respond(403, "not json"), () => refusals++)("https://example.com/x");
  await watchAiConsentRefusals(respond(200, refused), () => refusals++)("https://example.com/x");
  await tick();
  expect(refusals).toBe(1);
});
