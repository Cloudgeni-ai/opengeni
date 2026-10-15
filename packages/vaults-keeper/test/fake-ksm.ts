/**
 * An in-process Keeper Secrets Manager server for adapter tests, built from the
 * wire format in @keeper-security/secrets-manager-core 17.6.0 (dist/index.cjs.js):
 * request payloads are AES-256-GCM under the transmission key and ECDSA-SHA256
 * signed by the client key pair; binding returns the application key wrapped
 * with the one-time client key; shared folder keys are wrapped with the
 * application key (GCM), subfolder keys with the shared folder key (CBC);
 * record keys with folder keys; record and file data with their own keys.
 * Error bodies use the SDK's `result_code` JSON shape. It is a test double,
 * not proof of Keeper's live behaviour.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  verify,
} from "node:crypto";
import type { KeeperFileFetcher, KeeperQueryFunction } from "../src/sdk";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const webSafe = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64 = (text: string) => Buffer.from(text, "base64");

function gcm(key: Uint8Array, data: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const out = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, out, cipher.getAuthTag()]);
}
function ungcm(key: Uint8Array, data: Uint8Array): Buffer {
  const buffer = Buffer.from(data);
  const decipher = createDecipheriv("aes-256-gcm", key, buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(buffer.length - 16));
  return Buffer.concat([
    decipher.update(buffer.subarray(12, buffer.length - 16)),
    decipher.final(),
  ]);
}
function cbc(key: Uint8Array, data: Uint8Array): Buffer {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(data), cipher.final()]);
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

export type FakeFolder = {
  uid: string;
  name: string;
  key: Buffer;
  parent?: string;
  editable: boolean;
};
export type FakeFile = {
  fileUid: string;
  key: Buffer;
  meta: Record<string, unknown>;
  content: Buffer;
};
export type FakeRecord = {
  uid: string;
  folderUid?: string;
  innerFolderUid?: string;
  key: Buffer;
  data: Record<string, unknown>;
  revision: number;
  files: FakeFile[];
  /** Encrypt the record with a wrong key so the SDK skips it. */
  corrupt?: boolean;
};

export type FakeHooks = {
  /** Respond to the next request on `path` with this status and body. */
  failNext?: { path: string; status: number; body: Record<string, unknown> } | null;
  /** Process the next mutation on `path`, then lose the response. */
  dropResponse?: string | null;
  /** Require this transmission key id; others get a `key` rotation error. */
  requireKeyId?: number | null;
};

export function uid(): string {
  return webSafe(randomBytes(16));
}

export class FakeKsm {
  readonly host: string;
  readonly appKey = randomBytes(32);
  appTitle = "Opengeni CI App";
  readonly ownerPublicRaw: Buffer;
  readonly folders = new Map<string, FakeFolder>();
  readonly records = new Map<string, FakeRecord>();
  readonly requests: Array<{ path: string; clientId: string; keyId: number }> = [];
  readonly hooks: FakeHooks = {};
  private readonly tokens = new Map<string, { clientKey: Buffer; publicKey: string | null }>();

  constructor(host = "keepersecurity.com") {
    this.host = host;
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    this.ownerPublicRaw = Buffer.concat([
      Buffer.of(4),
      Buffer.from(jwk.x, "base64url"),
      Buffer.from(jwk.y, "base64url"),
    ]);
  }

  /** A one-time token with the US region prefix (or bare when `region` is null). */
  createToken(region: string | null = "US"): string {
    const clientKey = randomBytes(32);
    const clientId = b64(
      createHmac("sha512", clientKey).update("KEEPER_SECRETS_MANAGER_CLIENT_ID").digest(),
    );
    this.tokens.set(clientId, { clientKey, publicKey: null });
    return region === null ? webSafe(clientKey) : `${region}:${webSafe(clientKey)}`;
  }

  addFolder(name: string, options: { editable?: boolean; parent?: string } = {}): FakeFolder {
    const folder: FakeFolder = {
      uid: uid(),
      name,
      key: randomBytes(32),
      editable: options.editable ?? true,
      ...(options.parent ? { parent: options.parent } : {}),
    };
    this.folders.set(folder.uid, folder);
    return folder;
  }

  addRecord(
    folderUid: string | undefined,
    data: Record<string, unknown>,
    extra: Partial<FakeRecord> = {},
  ): FakeRecord {
    const record: FakeRecord = {
      uid: uid(),
      key: randomBytes(32),
      data,
      revision: 1,
      files: [],
      ...extra,
    };
    if (folderUid) record.folderUid = folderUid;
    this.records.set(record.uid, record);
    return record;
  }

  addFile(record: FakeRecord, name: string, content: Buffer, size = content.length): FakeFile {
    const file: FakeFile = {
      fileUid: uid(),
      key: randomBytes(32),
      meta: { name, title: name, size, type: "application/octet-stream", lastModified: 0 },
      content,
    };
    record.files.push(file);
    return file;
  }

  private sharedFolderOf(folder: FakeFolder): FakeFolder {
    let current = folder;
    while (current.parent) current = this.folders.get(current.parent)!;
    return current;
  }

  private encodeRecord(record: FakeRecord, wrapKey: Buffer) {
    const dataKey = record.corrupt ? randomBytes(32) : record.key;
    return {
      recordUid: record.uid,
      recordKey: b64(gcm(wrapKey, record.key)),
      data: webSafe(gcm(dataKey, json(record.data))),
      revision: record.revision,
      isEditable: true,
      files: record.files.map((file) => ({
        fileUid: file.fileUid,
        fileKey: b64(gcm(record.key, file.key)),
        data: b64(gcm(file.key, json(file.meta))),
        url: `https://files.keeper.test/${file.fileUid}?X-Amz-Signature=fake`,
        thumbnailUrl: null,
      })),
      ...(record.innerFolderUid ? { innerFolderUid: record.innerFolderUid } : {}),
    };
  }

  private error(status: number, body: Record<string, unknown>) {
    return { statusCode: status, headers: {}, data: new Uint8Array(json(body)) };
  }

  readonly queryFunction: KeeperQueryFunction = async (url, transmissionKey, payload) => {
    const parsed = new URL(url);
    if (parsed.hostname !== this.host)
      throw new Error(`fake KSM: unexpected host ${parsed.hostname}`);
    const path = parsed.pathname.replace("/api/rest/sm/v1/", "");
    const request = JSON.parse(ungcm(transmissionKey.key, payload.payload).toString()) as Record<
      string,
      unknown
    >;
    const clientId = request.clientId as string;
    this.requests.push({ path, clientId, keyId: transmissionKey.publicKeyId });

    if (this.hooks.requireKeyId && transmissionKey.publicKeyId !== this.hooks.requireKeyId) {
      return this.error(400, { result_code: "key", key_id: this.hooks.requireKeyId });
    }
    const failure = this.hooks.failNext;
    if (failure && failure.path === path) {
      this.hooks.failNext = null;
      return this.error(failure.status, failure.body);
    }

    const client = this.tokens.get(clientId);
    if (!client)
      return this.error(403, {
        result_code: "access_denied",
        message: "Client ID is not recognized",
      });
    const signingKey = (request.publicKey as string | undefined) ?? client.publicKey;
    if (request.publicKey && client.publicKey) {
      return this.error(403, {
        result_code: "access_denied",
        message: "One-time token was already used",
      });
    }
    if (!signingKey)
      return this.error(403, { result_code: "access_denied", message: "Client is not bound" });
    const raw = fromB64(signingKey);
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: raw.subarray(1, 33).toString("base64url"),
        y: raw.subarray(33, 65).toString("base64url"),
      },
      format: "jwk",
    });
    const signed = Buffer.concat([
      Buffer.from(transmissionKey.encryptedKey),
      Buffer.from(payload.payload),
    ]);
    if (!verify("sha256", signed, key, Buffer.from(payload.signature))) {
      return this.error(403, { result_code: "access_denied", message: "Signature is invalid" });
    }

    const respond = (body: unknown) => ({
      statusCode: 200,
      headers: {},
      data: new Uint8Array(gcm(transmissionKey.key, json(body))),
    });

    if (path === "get_secret") {
      const body: Record<string, unknown> = {};
      if (request.publicKey) {
        client.publicKey = request.publicKey as string;
        body.encryptedAppKey = b64(gcm(client.clientKey, this.appKey));
        body.appOwnerPublicKey = b64(this.ownerPublicRaw);
      }
      const wanted = request.requestedRecords as string[] | undefined;
      const include = (record: FakeRecord) => !wanted || wanted.includes(record.uid);
      body.folders = [...this.folders.values()]
        .filter((folder) => !folder.parent)
        .map((folder) => ({
          folderUid: folder.uid,
          folderKey: b64(gcm(this.appKey, folder.key)),
          records: [...this.records.values()]
            .filter(
              (record) =>
                record.folderUid &&
                this.sharedFolderOf(this.folders.get(record.folderUid)!) === folder,
            )
            .filter(include)
            .map((record) => {
              const encoded = this.encodeRecord(record, folder.key);
              const own = this.folders.get(record.folderUid!)!;
              return own.parent ? { ...encoded, innerFolderUid: own.uid } : encoded;
            }),
        }));
      body.records = [...this.records.values()]
        .filter((record) => !record.folderUid)
        .filter(include)
        .map((record) => this.encodeRecord(record, this.appKey));
      body.appData = webSafe(gcm(this.appKey, json({ title: this.appTitle, type: "general" })));
      body.expiresOn = 0;
      return respond(body);
    }

    if (path === "get_folders") {
      return respond({
        folders: [...this.folders.values()].map((folder) => {
          const parent = folder.parent ? this.folders.get(folder.parent)! : null;
          return {
            folderUid: folder.uid,
            folderKey: parent
              ? b64(cbc(this.sharedFolderOf(folder).key, folder.key))
              : b64(gcm(this.appKey, folder.key)),
            data: b64(cbc(folder.key, json({ name: folder.name }))),
            ...(parent ? { parent: parent.uid } : {}),
          };
        }),
      });
    }

    if (path === "create_secret") {
      const folder = this.folders.get(request.folderUid as string);
      if (!folder)
        return this.error(400, { result_code: "error", message: "Shared folder not found" });
      if (!folder.editable) {
        return this.error(403, {
          result_code: "access_denied",
          message: "No edit permission on the shared folder",
        });
      }
      const recordKey = ungcm(folder.key, fromB64(request.folderKey as string));
      const data = JSON.parse(ungcm(recordKey, fromB64(request.data as string)).toString());
      const record: FakeRecord = {
        uid: request.recordUid as string,
        key: recordKey,
        data,
        revision: 1,
        files: [],
        folderUid: folder.uid,
      };
      this.records.set(record.uid, record);
      if (this.hooks.dropResponse === path) {
        this.hooks.dropResponse = null;
        throw new Error("socket hang up");
      }
      return respond({});
    }

    if (path === "update_secret") {
      const record = this.records.get(request.recordUid as string);
      if (!record) return this.error(400, { result_code: "error", message: "Record not found" });
      const folder = record.folderUid ? this.folders.get(record.folderUid) : undefined;
      if (folder && !this.sharedFolderOf(folder).editable) {
        return this.error(403, {
          result_code: "access_denied",
          message: "No edit permission on the record",
        });
      }
      if (request.revision !== record.revision) {
        return this.error(400, { result_code: "error", message: "Record revision is out of date" });
      }
      record.data = JSON.parse(ungcm(record.key, fromB64(request.data as string)).toString());
      record.revision += 1;
      if (this.hooks.dropResponse === path) {
        this.hooks.dropResponse = null;
        throw new Error("socket hang up");
      }
      return respond({});
    }

    return this.error(400, {
      result_code: "error",
      message: `fake KSM does not implement ${path}`,
    });
  };

  readonly fetchFile: KeeperFileFetcher = async (url, options) => {
    const fileUid = new URL(url).pathname.slice(1);
    for (const record of this.records.values()) {
      const file = record.files.find((candidate) => candidate.fileUid === fileUid);
      if (file) {
        const encrypted = gcm(file.key, file.content);
        if (encrypted.length > options.maxBytes) throw new Error("fake: body exceeds bound");
        return new Uint8Array(encrypted);
      }
    }
    throw new Error("fake: no such file");
  };
}

export function loginData(title: string, extra: Partial<Record<string, unknown>> = {}) {
  return {
    type: "login",
    title,
    notes: "rotate monthly",
    fields: [
      { type: "login", value: ["alice"] },
      { type: "password", value: ["pw-123"] },
      { type: "url", value: ["https://login.example.test"] },
      { type: "fileRef", value: [] },
      {
        type: "oneTimeCode",
        value: ["otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example"],
      },
    ],
    custom: [
      { type: "text", label: "otp", value: ["not-a-seed"] },
      { type: "secret", label: "recovery", value: ["rc-1"] },
      { type: "secret", label: "recovery", value: ["rc-2"] },
      {
        type: "paymentCard",
        value: [{ cardNumber: "4111", cardExpirationDate: "01/30", cardSecurityCode: "123" }],
      },
    ],
    ...extra,
  };
}
