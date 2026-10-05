import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { ClaimedNativePushDelivery } from "@opengeni/db";
import { createFcmSender, nativePushAlert, nativePushData } from "../src/native-push-dispatch";
import { nativeAppRedirectAllowed, pkceS256Challenge } from "../src/routes/native-app-auth";

const payload: ClaimedNativePushDelivery["payload"] = {
  rule: "needs_input",
  sessionId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "user:abc",
  body: "Which branch should I use?",
};

function delivery(token = "fcm-token-123"): ClaimedNativePushDelivery {
  return {
    deliveryId: "33333333-3333-4333-8333-333333333333",
    platform: "android",
    appId: "dev.opengeni.app",
    environment: "production",
    token,
    payload,
    attempts: 1,
  };
}

describe("native push presentation", () => {
  test("falls back to a title per rule and keeps the agent's text", () => {
    expect(nativePushAlert(payload)).toEqual({
      title: "The agent needs you",
      body: "Which branch should I use?",
    });
    expect(nativePushAlert({ ...payload, rule: "failed", body: undefined })).toEqual({
      title: "A turn failed",
      body: "A turn failed",
    });
    expect(nativePushAlert({ ...payload, title: "Fix the build" }).title).toBe("Fix the build");
  });

  test("carries exactly what a tap needs to open the session in its account", () => {
    expect(nativePushData(payload)).toEqual({
      sessionId: payload.sessionId,
      workspaceId: payload.workspaceId,
      subjectId: "user:abc",
      rule: "needs_input",
    });
  });
});

describe("FCM sender", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serviceAccountJson = JSON.stringify({
    project_id: "push-project",
    client_email: "sender@push-project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });

  function fakeFetch(messageStatus: number, messageBody = "{}") {
    const calls: Array<{ url: string; body: string; authorization: string | null }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        body: String(init?.body ?? ""),
        authorization: headers.get("authorization"),
      });
      if (url.includes("oauth2")) {
        return Response.json({ access_token: "access-1", expires_in: 3600 });
      }
      return new Response(messageBody, { status: messageStatus });
    }) as typeof fetch;
    return { calls, fetcher };
  }

  test("exchanges a signed assertion once and sends a data message the app presents", async () => {
    const { calls, fetcher } = fakeFetch(200);
    const send = createFcmSender({ serviceAccountJson, fetch: fetcher });
    expect(await send(delivery())).toEqual({ outcome: "delivered" });
    expect(await send(delivery())).toEqual({ outcome: "delivered" });
    expect(calls.filter((call) => call.url.includes("oauth2"))).toHaveLength(1);
    const message = calls.find((call) => call.url.includes("messages:send"))!;
    expect(message.url).toBe("https://fcm.googleapis.com/v1/projects/push-project/messages:send");
    expect(message.authorization).toBe("Bearer access-1");
    const sent = JSON.parse(message.body) as {
      message: { token: string; data: Record<string, string> };
    };
    expect(sent.message.token).toBe("fcm-token-123");
    expect(sent.message.data.title).toBe("The agent needs you");
    expect(sent.message.data.message).toBe("Which branch should I use?");
    expect(JSON.parse(sent.message.data.body!)).toMatchObject({ sessionId: payload.sessionId });
  });

  test("maps provider answers to settle outcomes", async () => {
    expect(
      (await createFcmSender({ serviceAccountJson, fetch: fakeFetch(404).fetcher })(delivery()))
        .outcome,
    ).toBe("unregistered");
    expect(
      (await createFcmSender({ serviceAccountJson, fetch: fakeFetch(503).fetcher })(delivery()))
        .outcome,
    ).toBe("retry");
    expect(
      (await createFcmSender({ serviceAccountJson, fetch: fakeFetch(400).fetcher })(delivery()))
        .outcome,
    ).toBe("failed");
  });
});

describe("native app sign-in helpers", () => {
  test("only an exact registered scheme callback is allowed", () => {
    expect(nativeAppRedirectAllowed("opengeni://auth/callback", ["opengeni"])).toBe(true);
    expect(nativeAppRedirectAllowed("opengeni://auth/callback?x=1", ["opengeni"])).toBe(false);
    expect(nativeAppRedirectAllowed("evil://auth/callback", ["opengeni"])).toBe(false);
    expect(nativeAppRedirectAllowed("https://auth/callback", ["opengeni"])).toBe(false);
  });

  test("PKCE S256 matches RFC 7636 appendix B", () => {
    expect(pkceS256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});
