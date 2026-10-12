import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { BrowserPasskeyCredential, BrowserPasskeySyncRequest } from "@opengeni/contracts";
import { BrowserPasskeyManager, VIRTUAL_AUTHENTICATOR_OPTIONS } from "../src/passkeys";

type Call = { method: string; params: Record<string, unknown>; sessionId: string | undefined };
type StoredCredential = { credentialId: string; signCount: number; privateKey: string };

/** Minimal CDP peer: one virtual authenticator per session, credentials keyed by id. */
class FakeCdp {
  readonly calls: Call[] = [];
  readonly authenticators = new Map<string, Map<string, StoredCredential>>();
  private readonly listeners = new Map<string, Set<(event: { params: Record<string, unknown> }) => void>>();
  url = "https://login.example.test/account/passkeys";

  async send<T>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    options: { sessionId?: string } = {},
  ): Promise<T> {
    const sessionId = options.sessionId;
    this.calls.push({ method, params: { ...params }, sessionId });
    const store = sessionId ? this.authenticators.get(sessionId) : undefined;
    switch (method) {
      case "WebAuthn.enable":
        return {} as T;
      case "WebAuthn.addVirtualAuthenticator":
        if (sessionId === "broken") throw new Error("WebAuthn domain unavailable");
        this.authenticators.set(sessionId!, new Map());
        return { authenticatorId: `authenticator-${sessionId}` } as T;
      case "WebAuthn.addCredential": {
        const credential = params.credential as StoredCredential;
        store!.set(credential.credentialId, { ...credential });
        return {} as T;
      }
      case "WebAuthn.removeCredential":
        store!.delete(params.credentialId as string);
        return {} as T;
      case "Target.getTargetInfo":
        return { targetInfo: { url: this.url } } as T;
      default:
        throw new Error(`unexpected ${method}`);
    }
  }

  on(
    method: string,
    listener: (event: { params: Record<string, unknown> }) => void,
    sessionId?: string,
  ): () => void {
    const key = `${sessionId ?? ""}\0${method}`;
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => set.delete(listener);
  }

  emit(sessionId: string, method: string, params: Record<string, unknown>): void {
    for (const listener of this.listeners.get(`${sessionId}\0${method}`) ?? []) {
      listener({ params });
    }
  }

  installed(sessionId: string): Record<string, number> {
    return Object.fromEntries(
      [...(this.authenticators.get(sessionId) ?? new Map<string, StoredCredential>())].map(
        ([id, credential]) => [id, credential.signCount],
      ),
    );
  }
}

const binding = { browserSessionId: randomUUID(), controllerGeneration: "controller-1" };

function setup() {
  const cdp = new FakeCdp();
  const manager = new BrowserPasskeyManager({
    ...binding,
    now: () => new Date("2026-10-12T12:00:00.000Z"),
  });
  const sync = (
    credentials: BrowserPasskeyCredential[] | null,
    acknowledgeEventIds: string[] = [],
  ) =>
    manager.sync({
      protocolVersion: 1,
      ...binding,
      credentials,
      acknowledgeEventIds,
    } satisfies BrowserPasskeySyncRequest);
  return { cdp, manager, sync };
}

// "credential-1" bytes in standard (CDP) and url-safe (vault) base64 spellings.
const STANDARD_ID = "Y3JlZC0x+/8=";
const URL_ID = "Y3JlZC0x-_8";

function vaultCredential(overrides: Partial<BrowserPasskeyCredential> = {}): BrowserPasskeyCredential {
  return {
    itemId: randomUUID(),
    rpId: "login.example.test",
    credentialId: URL_ID,
    userHandle: "dXNlci0x",
    userName: "alice",
    userDisplayName: "Alice",
    privateKey: "cHJpdmF0ZS1rZXktMQ",
    signCount: 4,
    ...overrides,
  };
}

test("installs one ctap2.1 internal authenticator per tab holding the desired set", async () => {
  const { cdp, manager, sync } = setup();
  expect(await manager.attachTarget(cdp, { targetId: "tab-a", sessionId: "a" })).toBe(true);
  expect(await manager.attachTarget(cdp, { targetId: "tab-a", sessionId: "a2" })).toBe(false);
  expect(await manager.attachTarget(cdp, { targetId: "tab-x", sessionId: "broken" })).toBe(false);
  const added = cdp.calls.find((call) => call.method === "WebAuthn.addVirtualAuthenticator");
  expect(added?.params).toEqual({ options: VIRTUAL_AUTHENTICATOR_OPTIONS });
  const credential = vaultCredential();
  expect(await sync([credential])).toEqual({ ...binding, authenticators: 1, events: [] });
  // Vault base64url becomes CDP's standard padded base64.
  expect(cdp.installed("a")).toEqual({ [STANDARD_ID]: 4 });
  const install = cdp.calls.find((call) => call.method === "WebAuthn.addCredential");
  expect(install?.params.credential).toEqual({
    credentialId: STANDARD_ID,
    isResidentCredential: true,
    rpId: "login.example.test",
    privateKey: "cHJpdmF0ZS1rZXktMQ==",
    userHandle: "dXNlci0x",
    signCount: 4,
    userName: "alice",
    userDisplayName: "Alice",
  });
  // A tab opened later (popup, new tab) receives every desired credential.
  await manager.attachTarget(cdp, { targetId: "tab-b", sessionId: "b" });
  expect(cdp.installed("b")).toEqual({ [STANDARD_ID]: 4 });
  expect((await sync(null)).authenticators).toBe(2);
  manager.detachSession("b");
  expect((await sync(null)).authenticators).toBe(1);
  manager.detachConnection(cdp);
  expect((await sync(null)).authenticators).toBe(0);
});

test("reports a page registration, shares it with every tab and keeps it until acknowledged", async () => {
  const { cdp, manager, sync } = setup();
  await manager.attachTarget(cdp, { targetId: "tab-a", sessionId: "a" });
  await manager.attachTarget(cdp, { targetId: "tab-b", sessionId: "b" });
  cdp.authenticators.get("a")!.set("bmV3LWNyZWQ=", {
    credentialId: "bmV3LWNyZWQ=",
    signCount: 0,
    privateKey: "bmV3LWtleQ==",
  });
  cdp.emit("a", "WebAuthn.credentialAdded", {
    authenticatorId: "authenticator-a",
    credential: {
      credentialId: "bmV3LWNyZWQ=",
      isResidentCredential: true,
      rpId: "login.example.test",
      privateKey: "bmV3LWtleQ==",
      userHandle: "dXNlci0y",
      userName: "bob",
      signCount: 0,
    },
  });
  const first = await sync(null);
  expect(first.events).toEqual([
    {
      type: "registered",
      eventId: expect.any(String),
      occurredAt: "2026-10-12T12:00:00.000Z",
      targetId: "tab-a",
      origin: "https://login.example.test",
      credential: {
        rpId: "login.example.test",
        credentialId: "bmV3LWNyZWQ=",
        userHandle: "dXNlci0y",
        userName: "bob",
        userDisplayName: null,
        privateKey: "bmV3LWtleQ==",
        signCount: 0,
      },
    },
  ]);
  expect(cdp.installed("b")).toEqual({ "bmV3LWNyZWQ=": 0 });
  // Our own installs echo as additions; they are never new registrations.
  cdp.emit("b", "WebAuthn.credentialAdded", {
    authenticatorId: "authenticator-b",
    credential: { credentialId: "bmV3LWNyZWQ=", rpId: "login.example.test", privateKey: "x", signCount: 0 },
  });
  // A replacement that does not (yet) include it keeps an unacknowledged registration.
  const other = vaultCredential();
  expect((await sync([other])).events).toHaveLength(1);
  expect(cdp.installed("b")).toEqual({ "bmV3LWNyZWQ=": 0, [STANDARD_ID]: 4 });
  // Acknowledged and saved: the vault now supplies it with its item id.
  const saved = vaultCredential({
    credentialId: "bmV3LWNyZWQ",
    userHandle: "dXNlci0y",
    privateKey: "bmV3LWtleQ",
    signCount: 0,
  });
  expect((await sync([other, saved], [first.events[0]!.eventId])).events).toEqual([]);
  expect(cdp.installed("a")).toEqual({ "bmV3LWNyZWQ=": 0, [STANDARD_ID]: 4 });
  // Acknowledged, then no longer desired: removed from every tab.
  await sync([other]);
  expect(cdp.installed("a")).toEqual({ [STANDARD_ID]: 4 });
  expect(cdp.installed("b")).toEqual({ [STANDARD_ID]: 4 });
});

test("propagates the newest sign count to every tab and coalesces assertion events", async () => {
  const { cdp, manager, sync } = setup();
  await manager.attachTarget(cdp, { targetId: "tab-a", sessionId: "a" });
  await manager.attachTarget(cdp, { targetId: "tab-b", sessionId: "b" });
  const credential = vaultCredential({ signCount: 4 });
  await sync([credential]);
  const assert = (sessionId: string, signCount: number) => {
    // The authenticator bumps its own counter, then reports it.
    cdp.authenticators.get(sessionId)!.get(STANDARD_ID)!.signCount = signCount;
    cdp.emit(sessionId, "WebAuthn.credentialAsserted", {
      authenticatorId: `authenticator-${sessionId}`,
      credential: { credentialId: STANDARD_ID, rpId: "login.example.test", signCount },
    });
  };
  cdp.calls.length = 0;
  assert("a", 5);
  let pending = (await sync(null)).events;
  expect(pending).toEqual([
    {
      type: "asserted",
      eventId: expect.any(String),
      occurredAt: "2026-10-12T12:00:00.000Z",
      targetId: "tab-a",
      rpId: "login.example.test",
      credentialId: URL_ID,
      itemId: credential.itemId,
      signCount: 5,
    },
  ]);
  // The other tab's copy is replaced with the higher counter.
  expect(cdp.calls.map((call) => `${call.sessionId}:${call.method}`)).toEqual([
    "b:WebAuthn.removeCredential",
    "b:WebAuthn.addCredential",
  ]);
  expect(cdp.installed("b")).toEqual({ [STANDARD_ID]: 5 });
  assert("b", 6);
  pending = (await sync(null)).events;
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ type: "asserted", targetId: "tab-b", signCount: 6 });
  expect(cdp.installed("a")).toEqual({ [STANDARD_ID]: 6 });
  // A stale vault counter never lowers what the tabs hold.
  expect((await sync([{ ...credential, signCount: 2 }], [pending[0]!.eventId])).events).toEqual([]);
  expect(cdp.installed("a")).toEqual({ [STANDARD_ID]: 6 });
  expect(cdp.installed("b")).toEqual({ [STANDARD_ID]: 6 });
  // A higher counter from another session is installed everywhere.
  await sync([{ ...credential, signCount: 9 }]);
  expect(cdp.installed("a")).toEqual({ [STANDARD_ID]: 9 });
  expect(cdp.installed("b")).toEqual({ [STANDARD_ID]: 9 });
});

test("rejects a sync for another controller binding", async () => {
  const { manager } = setup();
  await expect(
    manager.sync({
      protocolVersion: 1,
      browserSessionId: binding.browserSessionId,
      controllerGeneration: "controller-2",
      credentials: null,
      acknowledgeEventIds: [],
    }),
  ).rejects.toThrow("passkey sync targets another browser controller binding");
});
