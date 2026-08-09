import type { EditableArtifactAuthorizationPort } from "../domain/editable-artifacts/ports";
import {
  assertIsoTimestamp,
  editableArtifactId,
  editableArtifactScope,
  validateEditableArtifactActor,
  type EditableArtifactActor,
  type EditableArtifactId,
  type EditableArtifactModality,
  type EditableArtifactScope,
} from "../domain/editable-artifacts/types";
import { EditableArtifactLiveError } from "./errors";
import type {
  EditableArtifactLiveClockPort,
  EditableArtifactLiveTicketStorePort,
  EditableArtifactLiveTokenPort,
} from "./ports";
import {
  EDITABLE_ARTIFACT_LIVE_PROTOCOL_VERSION,
  type EditableArtifactLiveTicket,
  type EditableArtifactLiveTicketRecord,
} from "./types";

const DEFAULT_TTL_MS = 30_000;
const MAX_TTL_MS = 60_000;
const MAX_TOKEN_BYTES = 4_096;

export type EditableArtifactLiveTicketAuthorityDependencies = Readonly<{
  authorization: EditableArtifactAuthorizationPort;
  tickets: EditableArtifactLiveTicketStorePort;
  tokens: EditableArtifactLiveTokenPort;
  clock: EditableArtifactLiveClockPort;
  ttlMs?: number;
  protocolVersion?: number;
}>;

export class EditableArtifactLiveTicketAuthority {
  private readonly ttlMs: number;
  private readonly protocolVersion: number;

  constructor(private readonly dependencies: EditableArtifactLiveTicketAuthorityDependencies) {
    this.ttlMs = dependencies.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1_000 || this.ttlMs > MAX_TTL_MS) {
      throw new TypeError(`ticket ttl must be 1000-${MAX_TTL_MS} milliseconds`);
    }
    this.protocolVersion = dependencies.protocolVersion ?? EDITABLE_ARTIFACT_LIVE_PROTOCOL_VERSION;
    if (!Number.isSafeInteger(this.protocolVersion) || this.protocolVersion < 1) {
      throw new TypeError("protocol version must be a positive safe integer");
    }
  }

  async mint(
    input: Readonly<{
      scope: EditableArtifactScope;
      artifactId: EditableArtifactId;
      modality: EditableArtifactModality;
      actor: EditableArtifactActor;
      allowEdit: boolean;
    }>,
  ): Promise<EditableArtifactLiveTicket> {
    const scope = editableArtifactScope(input.scope);
    const artifactId = editableArtifactId(input.artifactId);
    const modality = assertModality(input.modality);
    validateEditableArtifactActor(input.actor);
    if (typeof input.allowEdit !== "boolean") {
      throw new TypeError("ticket allowEdit must be boolean");
    }
    const actor = Object.freeze({ ...input.actor }) as EditableArtifactActor;
    const decision = await this.dependencies.authorization.authorize({
      scope,
      artifactId,
      actor,
      permission: "read",
    });
    if (!decision.allowed) {
      throw new EditableArtifactLiveError(
        "permission_changed",
        "Editable artifact read permission denied",
      );
    }
    const token = this.dependencies.tokens.randomOpaqueToken();
    assertToken(token);
    const tokenDigest = await this.dependencies.tokens.digestOpaqueToken(token);
    assertDigest(tokenDigest);
    const issuedAtDate = this.dependencies.clock.now();
    if (!Number.isFinite(issuedAtDate.getTime()))
      throw new TypeError("clock returned an invalid date");
    const issuedAt = issuedAtDate.toISOString();
    const expiresAt = new Date(issuedAtDate.getTime() + this.ttlMs).toISOString();
    const record: EditableArtifactLiveTicketRecord = Object.freeze({
      tokenDigest,
      scope,
      artifactId,
      modality,
      actor,
      allowEdit: input.allowEdit,
      protocolVersion: this.protocolVersion,
      issuedAt,
      expiresAt,
    });
    await this.dependencies.tickets.put(record);
    return Object.freeze({
      artifactId,
      modality,
      replicaId: actor.replicaId,
      token,
      expiresAt,
      protocolVersion: this.protocolVersion,
    });
  }

  async consume(
    input: Readonly<{
      token: string;
      artifactId: EditableArtifactId;
      protocolVersion: number;
    }>,
  ): Promise<EditableArtifactLiveTicketRecord> {
    assertToken(input.token);
    const artifactId = editableArtifactId(input.artifactId);
    const digest = await this.dependencies.tokens.digestOpaqueToken(input.token);
    assertDigest(digest);
    const record = await this.dependencies.tickets.consume(digest);
    if (!record) {
      throw new EditableArtifactLiveError(
        "ticket_replayed",
        "Live ticket is invalid or was already consumed",
      );
    }
    validateTicketRecord(record);
    if (Date.parse(record.expiresAt) <= this.dependencies.clock.now().getTime()) {
      throw new EditableArtifactLiveError("ticket_expired", "Live ticket has expired", {
        retryable: true,
      });
    }
    if (record.artifactId !== artifactId) {
      throw new EditableArtifactLiveError("invalid_ticket", "Live ticket scope does not match");
    }
    if (
      record.protocolVersion !== input.protocolVersion ||
      input.protocolVersion !== this.protocolVersion
    ) {
      throw new EditableArtifactLiveError(
        "protocol_mismatch",
        "Editable artifact live protocol is unsupported",
      );
    }
    return Object.freeze({
      ...record,
      scope: editableArtifactScope(record.scope),
      actor: Object.freeze({ ...record.actor }) as EditableArtifactActor,
    });
  }
}

/** Single-process test/dev store. Production must inject a shared atomic CAS store. */
export class InMemoryEditableArtifactLiveTicketStore implements EditableArtifactLiveTicketStorePort {
  private readonly records = new Map<string, EditableArtifactLiveTicketRecord>();

  async put(record: EditableArtifactLiveTicketRecord): Promise<void> {
    if (this.records.has(record.tokenDigest)) throw new Error("Live ticket digest collision");
    this.records.set(record.tokenDigest, record);
  }

  async consume(tokenDigest: string): Promise<EditableArtifactLiveTicketRecord | null> {
    const record = this.records.get(tokenDigest) ?? null;
    if (record) this.records.delete(tokenDigest);
    return record;
  }
}

export class WebCryptoEditableArtifactLiveTokens implements EditableArtifactLiveTokenPort {
  randomOpaqueToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  }

  async digestOpaqueToken(token: string): Promise<string> {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    );
    return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
}

function validateTicketRecord(record: EditableArtifactLiveTicketRecord): void {
  assertDigest(record.tokenDigest);
  editableArtifactScope(record.scope);
  editableArtifactId(record.artifactId);
  assertModality(record.modality);
  validateEditableArtifactActor(record.actor);
  if (typeof record.allowEdit !== "boolean") {
    throw new TypeError("ticket allowEdit is invalid");
  }
  assertIsoTimestamp(record.issuedAt, "ticket issuedAt");
  assertIsoTimestamp(record.expiresAt, "ticket expiresAt");
}

function assertModality(value: EditableArtifactModality): EditableArtifactModality {
  if (value !== "document" && value !== "spreadsheet" && value !== "presentation") {
    throw new TypeError("ticket modality is invalid");
  }
  return value;
}

function assertToken(token: string): void {
  const bytes = new TextEncoder().encode(token).byteLength;
  if (bytes < 32 || bytes > MAX_TOKEN_BYTES || !/^[A-Za-z0-9._~-]+$/u.test(token)) {
    throw new EditableArtifactLiveError("invalid_ticket", "Live ticket is malformed");
  }
}

function assertDigest(value: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new TypeError("ticket digest is malformed");
}
