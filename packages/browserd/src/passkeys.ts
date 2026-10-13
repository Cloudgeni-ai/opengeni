import { randomUUID } from "node:crypto";
import {
  BROWSER_MAX_PASSKEY_EVENTS,
  BrowserPasskeySyncRequest,
  BrowserPasskeySyncResponse,
  type BrowserPasskeyCredentialMaterial,
  type BrowserPasskeyEvent,
  type BrowserPasskeySyncRequest as BrowserPasskeySyncRequestValue,
  type BrowserPasskeySyncResponse as BrowserPasskeySyncResponseValue,
} from "@opengeni/contracts";
import { InteractionControllerError } from "@opengeni/interaction";

/** The CDP surface the manager needs: flattened session sends and events. */
export type PasskeyCdpConnection = {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    options?: { sessionId?: string; timeoutMs?: number },
  ): Promise<T>;
  on(
    method: string,
    listener: (event: { params: Record<string, unknown> }) => void,
    sessionId?: string,
  ): () => void;
};

export type BrowserPasskeyManagerOptions = {
  browserSessionId: string;
  controllerGeneration: string;
  now?: () => Date;
  createId?: () => string;
  /** Bound for every CDP call; a hung tab must not wedge the other tabs. */
  commandTimeoutMs?: number;
};

/** Internal ctap2.1 platform authenticator with resident keys and automatic
 * user presence and verification, as a password manager's passkey provider. */
export const VIRTUAL_AUTHENTICATOR_OPTIONS = {
  protocol: "ctap2",
  ctap2Version: "ctap2_1",
  transport: "internal",
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
} as const;

type DesiredCredential = {
  material: BrowserPasskeyCredentialMaterial;
  /** Vault item it was loaded from; null for one registered in this session. */
  itemId: string | null;
  /** Registered in this session and its `registered` event not yet acknowledged. */
  unacknowledgedRegistration: boolean;
};

type Authenticator = {
  connection: PasskeyCdpConnection;
  targetId: string;
  sessionId: string;
  authenticatorId: string;
  /** Credential key → sign count of the copy installed in this authenticator. */
  installed: Map<string, number>;
  unsubscribe: Array<() => void>;
};

/**
 * One virtual WebAuthn authenticator per page target, all holding the same
 * credential set. Credentials registered in one tab are installed into every
 * other tab, and every assertion's sign count is propagated so no tab ever
 * presents a lower counter than the relying party last saw.
 *
 * Private keys and events live in memory only. Nothing here is logged or
 * journaled; the API drains events through `sync` and writes the vault.
 */
export class BrowserPasskeyManager {
  private readonly browserSessionId: string;
  private readonly controllerGeneration: string;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly timeoutMs: number;
  private readonly desired = new Map<string, DesiredCredential>();
  private readonly authenticators = new Map<string, Authenticator>();
  private events: BrowserPasskeyEvent[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(options: BrowserPasskeyManagerOptions) {
    this.browserSessionId = options.browserSessionId;
    this.controllerGeneration = options.controllerGeneration;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.timeoutMs = options.commandTimeoutMs ?? 5_000;
  }

  /** Page targets that currently host a virtual authenticator. */
  get authenticatorCount(): number {
    return this.authenticators.size;
  }

  /**
   * Install an authenticator holding every desired credential into one page
   * target. Call it before the target runs script (auto-attach paused).
   * Returns false when the target already has one or WebAuthn is unavailable.
   */
  async attachTarget(
    connection: PasskeyCdpConnection,
    target: { targetId: string; sessionId: string },
  ): Promise<boolean> {
    return await this.serial(async () => {
      for (const existing of this.authenticators.values()) {
        if (existing.connection === connection && existing.targetId === target.targetId)
          return false;
      }
      const { sessionId } = target;
      try {
        await this.send(connection, "WebAuthn.enable", { enableUI: false }, sessionId);
        const added = await this.send<{ authenticatorId?: unknown }>(
          connection,
          "WebAuthn.addVirtualAuthenticator",
          { options: VIRTUAL_AUTHENTICATOR_OPTIONS },
          sessionId,
        );
        if (typeof added.authenticatorId !== "string") return false;
        const authenticator: Authenticator = {
          connection,
          targetId: target.targetId,
          sessionId,
          authenticatorId: added.authenticatorId,
          installed: new Map(),
          unsubscribe: [],
        };
        authenticator.unsubscribe.push(
          connection.on(
            "WebAuthn.credentialAdded",
            (event) => void this.serial(() => this.onCredentialAdded(authenticator, event.params)),
            sessionId,
          ),
          connection.on(
            "WebAuthn.credentialAsserted",
            (event) =>
              void this.serial(() => this.onCredentialAsserted(authenticator, event.params)),
            sessionId,
          ),
          connection.on(
            "WebAuthn.credentialDeleted",
            (event) => {
              const id = event.params.credentialId;
              if (event.params.authenticatorId !== authenticator.authenticatorId) return;
              if (typeof id === "string") authenticator.installed.delete(credentialKey(id));
            },
            sessionId,
          ),
        );
        this.authenticators.set(sessionId, authenticator);
        for (const [key, credential] of this.desired) {
          await this.install(authenticator, key, credential);
        }
        return true;
      } catch {
        // A target without the WebAuthn domain (or one that closed during
        // setup) simply has no authenticator; the page still runs.
        this.forget(sessionId);
        return false;
      }
    });
  }

  /** The CDP session hosting an authenticator ended (tab closed or detached). */
  detachSession(sessionId: string): void {
    this.forget(sessionId);
  }

  /** A driver connection closed: all of its authenticators are gone. */
  detachConnection(connection: PasskeyCdpConnection): void {
    for (const [sessionId, authenticator] of [...this.authenticators]) {
      if (authenticator.connection === connection) this.forget(sessionId);
    }
  }

  /**
   * Controller-private sync. A non-null `credentials` replaces the loaded set
   * (keeping the higher of the local and supplied sign count per credential,
   * and in-session registrations not yet acknowledged). Acknowledged events are
   * dropped; every still-pending event is returned, oldest first.
   */
  async sync(input: BrowserPasskeySyncRequestValue): Promise<BrowserPasskeySyncResponseValue> {
    const request = BrowserPasskeySyncRequest.parse(input);
    if (
      request.browserSessionId !== this.browserSessionId ||
      request.controllerGeneration !== this.controllerGeneration
    ) {
      throw new InteractionControllerError(
        "operation_conflict",
        "passkey sync targets another browser controller binding",
      );
    }
    return await this.serial(async () => {
      const acknowledged = new Set(request.acknowledgeEventIds);
      for (const event of this.events) {
        if (!acknowledged.has(event.eventId) || event.type !== "registered") continue;
        const entry = this.desired.get(credentialKey(event.credential.credentialId));
        if (entry) entry.unacknowledgedRegistration = false;
      }
      this.events = this.events.filter((event) => !acknowledged.has(event.eventId));
      if (request.credentials !== null) await this.replaceDesired(request.credentials);
      return BrowserPasskeySyncResponse.parse({
        browserSessionId: this.browserSessionId,
        controllerGeneration: this.controllerGeneration,
        authenticators: this.authenticators.size,
        events: this.events.slice(0, BROWSER_MAX_PASSKEY_EVENTS),
      });
    });
  }

  private async replaceDesired(
    credentials: NonNullable<BrowserPasskeySyncRequestValue["credentials"]>,
  ): Promise<void> {
    const next = new Map<string, DesiredCredential>();
    for (const supplied of credentials) {
      const key = credentialKey(supplied.credentialId);
      const local = this.desired.get(key);
      const { itemId, ...material } = supplied;
      next.set(key, {
        material: {
          ...material,
          signCount: Math.max(material.signCount, local?.material.signCount ?? 0),
        },
        itemId,
        unacknowledgedRegistration: false,
      });
    }
    for (const [key, entry] of this.desired) {
      if (!next.has(key) && entry.unacknowledgedRegistration) next.set(key, entry);
    }
    const removed = [...this.desired.keys()].filter((key) => !next.has(key));
    this.desired.clear();
    for (const [key, entry] of next) this.desired.set(key, entry);
    for (const authenticator of [...this.authenticators.values()]) {
      for (const key of removed) await this.uninstall(authenticator, key);
      for (const [key, entry] of this.desired) {
        const installed = authenticator.installed.get(key);
        if (installed === undefined || installed < entry.material.signCount) {
          await this.install(authenticator, key, entry);
        }
      }
    }
  }

  private async onCredentialAdded(
    source: Authenticator,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (params.authenticatorId !== source.authenticatorId) return;
    if (!this.authenticators.has(source.sessionId)) return;
    let credential = cdpCredential(params.credential);
    if (!credential) return;
    const key = credentialKey(credential.credentialId);
    if (!credential.privateKey) {
      const fetched = await this.send<{ credential?: unknown }>(
        source.connection,
        "WebAuthn.getCredential",
        { authenticatorId: source.authenticatorId, credentialId: credential.credentialId },
        source.sessionId,
      ).catch(() => ({ credential: undefined }));
      credential = cdpCredential(fetched.credential) ?? credential;
    }
    source.installed.set(key, credential.signCount);
    // Our own installs may echo as additions. Only an unknown credential is a
    // registration made by the page.
    if (this.desired.has(key)) return;
    if (!credential.privateKey || !credential.rpId) return;
    const material: BrowserPasskeyCredentialMaterial = {
      rpId: credential.rpId,
      credentialId: credential.credentialId,
      userHandle: credential.userHandle,
      userName: credential.userName,
      userDisplayName: credential.userDisplayName,
      privateKey: credential.privateKey,
      signCount: credential.signCount,
    };
    const entry: DesiredCredential = { material, itemId: null, unacknowledgedRegistration: true };
    this.desired.set(key, entry);
    this.events.push({
      type: "registered",
      eventId: this.createId(),
      occurredAt: this.now().toISOString(),
      targetId: source.targetId,
      origin: await this.targetOrigin(source),
      credential: material,
    });
    for (const authenticator of [...this.authenticators.values()]) {
      if (authenticator !== source) await this.install(authenticator, key, entry);
    }
  }

  private async onCredentialAsserted(
    source: Authenticator,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (params.authenticatorId !== source.authenticatorId) return;
    const credential = cdpCredential(params.credential);
    if (!credential) return;
    const key = credentialKey(credential.credentialId);
    source.installed.set(key, credential.signCount);
    const entry = this.desired.get(key);
    if (entry) {
      entry.material = {
        ...entry.material,
        signCount: Math.max(entry.material.signCount, credential.signCount),
      };
    }
    const rpId = entry?.material.rpId ?? credential.rpId;
    if (rpId) {
      // Only the newest counter per credential matters (the vault keeps the
      // greatest), so a newer assertion replaces an undelivered older one.
      this.events = this.events.filter(
        (event) => event.type !== "asserted" || credentialKey(event.credentialId) !== key,
      );
      this.events.push({
        type: "asserted",
        eventId: this.createId(),
        occurredAt: this.now().toISOString(),
        targetId: source.targetId,
        rpId,
        credentialId: entry?.material.credentialId ?? credential.credentialId,
        itemId: entry?.itemId ?? null,
        signCount: Math.max(entry?.material.signCount ?? 0, credential.signCount),
      });
    }
    if (!entry) return;
    for (const authenticator of [...this.authenticators.values()]) {
      if (authenticator === source) continue;
      const installed = authenticator.installed.get(key);
      if (installed !== undefined && installed < entry.material.signCount) {
        await this.install(authenticator, key, entry);
      }
    }
  }

  /** Install (or reinstall with a newer counter) one credential. */
  private async install(
    authenticator: Authenticator,
    key: string,
    entry: DesiredCredential,
  ): Promise<void> {
    if (this.authenticators.get(authenticator.sessionId) !== authenticator) return;
    try {
      if (authenticator.installed.has(key)) await this.uninstall(authenticator, key);
      const { material } = entry;
      await this.send(
        authenticator.connection,
        "WebAuthn.addCredential",
        {
          authenticatorId: authenticator.authenticatorId,
          credential: {
            credentialId: standardBase64(material.credentialId),
            isResidentCredential: material.userHandle !== null,
            rpId: material.rpId,
            privateKey: standardBase64(material.privateKey),
            ...(material.userHandle !== null
              ? { userHandle: standardBase64(material.userHandle) }
              : {}),
            signCount: material.signCount,
            ...(material.userName !== null ? { userName: material.userName } : {}),
            ...(material.userDisplayName !== null
              ? { userDisplayName: material.userDisplayName }
              : {}),
          },
        },
        authenticator.sessionId,
      );
      authenticator.installed.set(key, material.signCount);
    } catch {
      // A closing tab loses its copy with it. Other tabs are unaffected.
    }
  }

  private async uninstall(authenticator: Authenticator, key: string): Promise<void> {
    if (!authenticator.installed.has(key)) return;
    authenticator.installed.delete(key);
    await this.send(
      authenticator.connection,
      "WebAuthn.removeCredential",
      { authenticatorId: authenticator.authenticatorId, credentialId: standardBase64(key) },
      authenticator.sessionId,
    ).catch(() => undefined);
  }

  private async targetOrigin(authenticator: Authenticator): Promise<string | null> {
    try {
      const info = await this.send<{ targetInfo?: { url?: unknown } }>(
        authenticator.connection,
        "Target.getTargetInfo",
        { targetId: authenticator.targetId },
      );
      const url = info.targetInfo?.url;
      if (typeof url !== "string") return null;
      const origin = new URL(url).origin;
      return origin === "null" ? null : origin.slice(0, 2_048);
    } catch {
      return null;
    }
  }

  private forget(sessionId: string): void {
    const authenticator = this.authenticators.get(sessionId);
    if (!authenticator) return;
    this.authenticators.delete(sessionId);
    for (const unsubscribe of authenticator.unsubscribe) unsubscribe();
  }

  private async send<T = Record<string, unknown>>(
    connection: PasskeyCdpConnection,
    method: string,
    params: Readonly<Record<string, unknown>>,
    sessionId?: string,
  ): Promise<T> {
    return await connection.send<T>(method, params, {
      ...(sessionId ? { sessionId } : {}),
      timeoutMs: this.timeoutMs,
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

type CdpCredential = {
  credentialId: string;
  rpId: string | null;
  privateKey: string | null;
  userHandle: string | null;
  userName: string | null;
  userDisplayName: string | null;
  signCount: number;
};

function cdpCredential(value: unknown): CdpCredential | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.credentialId !== "string" || !record.credentialId) return null;
  const text = (field: unknown, max: number) =>
    typeof field === "string" && field.length > 0 ? field.slice(0, max) : null;
  const signCount =
    typeof record.signCount === "number" &&
    Number.isSafeInteger(record.signCount) &&
    record.signCount >= 0
      ? Math.min(record.signCount, 0xffff_ffff)
      : 0;
  return {
    credentialId: record.credentialId,
    rpId: text(record.rpId, 253),
    privateKey: text(record.privateKey, 16_384),
    userHandle: text(record.userHandle, 16_384),
    userName: text(record.userName, 512),
    userDisplayName: text(record.userDisplayName, 512),
    signCount,
  };
}

/** Base64 and base64url spellings of the same bytes share one key. */
export function credentialKey(value: string): string {
  return value.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** CDP binary fields are standard, padded base64. */
export function standardBase64(value: string): string {
  const plain = value.replace(/-/gu, "+").replace(/_/gu, "/").replace(/=+$/u, "");
  return plain.padEnd(Math.ceil(plain.length / 4) * 4, "=");
}
