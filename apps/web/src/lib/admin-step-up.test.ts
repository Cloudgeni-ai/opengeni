import { describe, expect, test } from "bun:test";
import { ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE } from "@opengeni/contracts/managed-sign-in-methods";

import { adminStepUpRequested, setAdminStepUpHandler, withAdminStepUp } from "./admin-step-up";

const refused = (details: Record<string, unknown>) =>
  Response.json(
    { error: { code: "forbidden", message: "Confirm it's you", details } },
    { status: 403 },
  );
const stepUp = () =>
  refused({ code: ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE, passkeyRegistered: true });
const request = { input: "/v1/organizations/o", init: { method: "PATCH", body: "{}" } };

describe("admin step-up in the console", () => {
  test("reads only an admin step-up refusal", async () => {
    expect(await adminStepUpRequested(stepUp())).toEqual({ passkeyRegistered: true });
    expect(
      await adminStepUpRequested(
        refused({ code: ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE, passkeyRegistered: false }),
      ),
    ).toEqual({ passkeyRegistered: false });
    expect(await adminStepUpRequested(refused({ code: "SOMETHING_ELSE" }))).toBeNull();
    expect(await adminStepUpRequested(new Response("nope", { status: 403 }))).toBeNull();
    expect(await adminStepUpRequested(new Response("{}", { status: 200 }))).toBeNull();
  });

  test("sends the change again once the person confirms", async () => {
    const asked: unknown[] = [];
    const unmount = setAdminStepUpHandler(async (info) => {
      asked.push(info);
      return true;
    });
    let sends = 0;
    const response = await withAdminStepUp(async () => {
      sends += 1;
      return sends === 1 ? stepUp() : Response.json({ ok: true });
    }, request);
    expect(response.status).toBe(200);
    expect(sends).toBe(2);
    expect(asked).toEqual([{ passkeyRegistered: true }]);
    unmount();
  });

  test("keeps the refusal when they cancel, and without a prompt mounted", async () => {
    const unmount = setAdminStepUpHandler(async () => false);
    let sends = 0;
    const send = async () => {
      sends += 1;
      return stepUp();
    };
    expect((await withAdminStepUp(send, request)).status).toBe(403);
    expect(sends).toBe(1);
    unmount();
    expect((await withAdminStepUp(send, request)).status).toBe(403);
    expect(sends).toBe(2);
  });

  test("changes refused together share one prompt", async () => {
    let prompts = 0;
    let confirm: (value: boolean) => void = () => {};
    const unmount = setAdminStepUpHandler(() => {
      prompts += 1;
      return new Promise((resolve) => (confirm = resolve));
    });
    const sent = new Map<string, number>();
    const change = (name: string) =>
      withAdminStepUp(async () => {
        const count = (sent.get(name) ?? 0) + 1;
        sent.set(name, count);
        return count === 1 ? stepUp() : Response.json({ name });
      }, request);
    const both = Promise.all([change("a"), change("b")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    confirm(true);
    const [a, b] = await both;
    expect(prompts).toBe(1);
    expect(await a.json()).toEqual({ name: "a" });
    expect(await b.json()).toEqual({ name: "b" });
    unmount();
  });

  test("never resends a streamed body", async () => {
    const unmount = setAdminStepUpHandler(async () => true);
    let sends = 0;
    const response = await withAdminStepUp(
      async () => {
        sends += 1;
        return stepUp();
      },
      { input: "/v1/x", init: { method: "POST", body: new ReadableStream() } },
    );
    expect(response.status).toBe(403);
    expect(sends).toBe(1);
    unmount();
  });
});
