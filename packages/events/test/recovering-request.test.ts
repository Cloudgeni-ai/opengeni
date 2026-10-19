import { describe, expect, test } from "bun:test";
import type { Msg, NatsConnection, Subscription, SubscriptionOptions, Status } from "nats";
import { recoveringRequest } from "../src/recovering-request";

function transport() {
  const subscriptions = new Map<string, SubscriptionOptions>();
  const publications: Array<{ subject: string; data: Uint8Array; reply: string }> = [];
  const reconnects = new Set<(status: Status) => void>();
  let publishError: unknown;
  const connection = {
    options: {},
    subscribe(subject: string, options: SubscriptionOptions) {
      subscriptions.set(subject, options);
      let close!: () => void;
      return {
        closed: new Promise<void>((resolve) => {
          close = resolve;
        }),
        unsubscribe() {
          subscriptions.delete(subject);
          close();
        },
      } as Subscription;
    },
    publish(subject: string, data: Uint8Array, { reply }: { reply: string }) {
      if (publishError) throw publishError;
      publications.push({ subject, data, reply });
    },
  } as unknown as NatsConnection;
  return {
    connection,
    publications,
    subscriptions,
    reconnects,
    onReconnect(callback: (status: Status) => void) {
      reconnects.add(callback);
      return () => {
        reconnects.delete(callback);
      };
    },
    emit(subject: string, data = new Uint8Array([7]), code?: number) {
      subscriptions.get(subject)?.callback?.(null, { data, headers: { code } } as Msg);
    },
    failPublish(error: unknown) {
      publishError = error;
    },
  };
}

describe("replay-safe request reconnect notifications", () => {
  test("publish permission errors are scoped and do not wait for the deadline", async () => {
    const fixture = transport();
    const pending = recoveringRequest(
      fixture.connection,
      "exact.delivery",
      new Uint8Array(),
      { timeout: 60_000, resendOn: "exact.hello" },
      fixture.onReconnect,
    );
    for (const observer of fixture.reconnects) {
      observer({
        type: "error",
        data: "PERMISSIONS_VIOLATION",
        permissionContext: { operation: "publish", subject: "another.delivery" },
      });
    }
    expect(fixture.subscriptions.size).toBe(2);
    for (const observer of fixture.reconnects) {
      observer({
        type: "error",
        data: "PERMISSIONS_VIOLATION",
        permissionContext: { operation: "publish", subject: "exact.delivery" },
      });
    }
    await expect(pending).rejects.toMatchObject({ code: "PERMISSIONS_VIOLATION" });
    expect(fixture.subscriptions.size).toBe(0);
    expect(fixture.reconnects.size).toBe(0);
  });

  test("a local publish failure releases its listeners immediately", async () => {
    const fixture = transport();
    fixture.failPublish(Object.assign(new Error("too large"), { code: "MAX_PAYLOAD_EXCEEDED" }));
    await expect(
      recoveringRequest(
        fixture.connection,
        "exact.delivery",
        new Uint8Array(),
        { timeout: 60_000, resendOn: "exact.hello" },
        fixture.onReconnect,
      ),
    ).rejects.toMatchObject({ code: "MAX_PAYLOAD_EXCEEDED" });
    expect(fixture.subscriptions.size).toBe(0);
    expect(fixture.reconnects.size).toBe(0);
  });
  test("resends to the same inbox on responder or requester recovery and cleans everything", async () => {
    const fixture = transport();
    const payload = new Uint8Array([1]);
    const pending = recoveringRequest(
      fixture.connection,
      "exact.delivery",
      payload,
      { timeout: 60_000, resendOn: "exact.hello" },
      fixture.onReconnect,
    );
    expect([...fixture.subscriptions.keys()]).toContain("exact.hello");
    fixture.emit("other.hello");
    expect(fixture.publications).toHaveLength(1);
    fixture.emit("exact.hello");
    for (const reconnect of fixture.reconnects) reconnect({ type: "reconnect", data: "" });
    expect(fixture.publications).toHaveLength(3);
    expect(
      fixture.publications.every(
        (message) =>
          message.data === payload &&
          message.reply === fixture.publications[0]!.reply &&
          message.subject === "exact.delivery",
      ),
    ).toBe(true);
    fixture.emit(fixture.publications[0]!.reply);
    expect((await pending).data).toEqual(new Uint8Array([7]));
    expect(fixture.subscriptions.size).toBe(0);
    expect(fixture.reconnects.size).toBe(0);
  });

  test("responder recovery never resets a slow operation's deadline", async () => {
    const fixture = transport();
    const pending = recoveringRequest(
      fixture.connection,
      "exact.delivery",
      new Uint8Array(),
      { timeout: 30, resendOn: "exact.hello" },
      fixture.onReconnect,
    );
    const check = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    fixture.emit("exact.hello");
    await check;
    expect(fixture.subscriptions.size).toBe(0);
    expect(fixture.reconnects.size).toBe(0);
  });

  for (const recovered of [false, true]) {
    test(`no responder preserves ${recovered ? "uncertain" : "never-sent"} outcome`, async () => {
      const fixture = transport();
      const pending = recoveringRequest(
        fixture.connection,
        "exact.delivery",
        new Uint8Array(),
        { timeout: 60_000, resendOn: "exact.hello" },
        fixture.onReconnect,
      );
      if (recovered) fixture.emit("exact.hello");
      fixture.emit(fixture.publications[0]!.reply, new Uint8Array(), 503);
      await expect(pending).rejects.toMatchObject({ code: recovered ? "TIMEOUT" : "503" });
      expect(fixture.subscriptions.size).toBe(0);
    });
  }

  test("a permanent resend failure retains uncertainty and its original cause", async () => {
    const fixture = transport();
    const pending = recoveringRequest(
      fixture.connection,
      "exact.delivery",
      new Uint8Array(),
      { timeout: 60_000, resendOn: "exact.hello" },
      fixture.onReconnect,
    );
    fixture.failPublish(Object.assign(new Error("too large"), { code: "MAX_PAYLOAD_EXCEEDED" }));
    fixture.emit("exact.hello");
    await expect(pending).rejects.toMatchObject({
      code: "TIMEOUT",
      cause: { code: "MAX_PAYLOAD_EXCEEDED" },
    });
    expect(fixture.subscriptions.size).toBe(0);
  });
});
