import { randomUUID } from "node:crypto";
import {
  deriveMasterKey,
  encryptBytes,
  encryptString,
  generateRsaKeyPair,
  generateSymmetricKey,
  rsaEncrypt,
  sha256B64,
  stretchMasterKey,
  symmetricKeyBytes,
  type SymmetricKey,
} from "../src/crypto";

/**
 * A wire-level fake of the Bitwarden client API, shaped like Vaultwarden
 * 1.37: it stores ciphers encrypted exactly as clients send them and never
 * decrypts anything. Items are seeded the way official clients write them.
 */
export const FAKE_SERVER = "https://vault.example.test";
export const FAKE_EMAIL = "Agents@Example.test";
export const FAKE_MASTER_PASSWORD = "correct horse battery staple";
export const FAKE_USER_ID = "6f1c3c1e-2b1a-4c55-9d1e-0a0b0c0d0e0f";
export const FAKE_CLIENT_ID = `user.${FAKE_USER_ID}`;
export const FAKE_CLIENT_SECRET = "fake-client-secret-0123456789";

type Json = Record<string, any>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export class FakeBitwarden {
  readonly userKey: SymmetricKey = generateSymmetricKey();
  readonly orgId = randomUUID();
  readonly orgKey: SymmetricKey = generateSymmetricKey();
  readonly collections: Json[] = [];
  readonly ciphers = new Map<string, Json>();
  readonly files = new Map<string, Uint8Array>();
  readonly requests: string[] = [];
  logins = 0;
  rateLimitLogins = false;
  /** Overrides what `/api/config` names as the API and identity hosts. */
  environment: Json | null = null;
  /** An invited but unconfirmed member has no organization key yet. */
  orgConfirmed = true;
  private protectedKey = "";
  private privateKey = "";
  private orgKeyForUser = "";
  private readonly tokens = new Set<string>();
  private clock = Date.parse("2026-10-01T00:00:00.000Z");

  static async create(): Promise<FakeBitwarden> {
    const fake = new FakeBitwarden();
    const masterKey = await deriveMasterKey(FAKE_MASTER_PASSWORD, FAKE_EMAIL, {
      type: "pbkdf2",
      iterations: 5_000,
    });
    fake.protectedKey = encryptBytes(symmetricKeyBytes(fake.userKey), stretchMasterKey(masterKey));
    const rsa = generateRsaKeyPair();
    fake.privateKey = encryptBytes(rsa.privateKeyDer, fake.userKey);
    const publicDer = rsa.publicKeyDer;
    fake.orgKeyForUser = rsaEncrypt(symmetricKeyBytes(fake.orgKey), publicDer);
    return fake;
  }

  private nextRevision(): string {
    this.clock += 1_000;
    return new Date(this.clock).toISOString();
  }

  /** Signs every session out, as a server restart or token revocation would. */
  revokeTokens(): void {
    this.tokens.clear();
  }

  /** Changes a stored cipher as another client would, bumping its revision. */
  touch(cipherId: string, change: (cipher: Json) => void = () => {}): void {
    const cipher = this.ciphers.get(cipherId)!;
    change(cipher);
    cipher.revisionDate = this.nextRevision();
  }

  addCollection(
    name: string,
    access: { readOnly?: boolean; hidePasswords?: boolean } = {},
  ): string {
    const id = randomUUID();
    this.collections.push({
      id,
      organizationId: this.orgId,
      name: encryptString(name, this.orgKey),
      readOnly: access.readOnly === true,
      hidePasswords: access.hidePasswords === true,
      object: "collectionDetails",
    });
    return id;
  }

  /** Stores a cipher body as a client would POST it. */
  addCipher(body: Json, collectionIds: string[] = []): string {
    const id = randomUUID();
    this.ciphers.set(id, {
      ...body,
      id,
      collectionIds,
      attachments: body.attachments ?? null,
      revisionDate: this.nextRevision(),
      deletedDate: null,
      object: "cipherDetails",
    });
    return id;
  }

  addAttachment(cipherId: string, fileName: string, plain: Uint8Array, key: SymmetricKey): void {
    const cipher = this.ciphers.get(cipherId)!;
    const attachmentKey = generateSymmetricKey();
    const [, iv, ct, mac] = encryptBytes(plain, attachmentKey).match(
      /^2\.([^|]+)\|([^|]+)\|(.+)$/,
    )!;
    const body = Buffer.concat([
      Buffer.from([2]),
      Buffer.from(iv!, "base64"),
      Buffer.from(mac!, "base64"),
      Buffer.from(ct!, "base64"),
    ]);
    const id = randomUUID().replace(/-/g, "").slice(0, 20);
    this.files.set(id, new Uint8Array(body));
    cipher.attachments = [
      ...(cipher.attachments ?? []),
      {
        id,
        fileName: encryptString(fileName, key),
        key: encryptBytes(symmetricKeyBytes(attachmentKey), key),
        size: String(body.length),
        url: `${FAKE_SERVER}/attachments/${cipherId}/${id}`,
      },
    ];
  }

  /** A login in My vault or a collection, written as clients write it. */
  login(
    name: string,
    values: { username?: string; password?: string; totp?: string; uri?: string; notes?: string },
    key: SymmetricKey = this.userKey,
    organizationId: string | null = null,
  ): Json {
    const enc = (value: string | undefined) =>
      value === undefined ? null : encryptString(value, key);
    return {
      type: 1,
      organizationId,
      folderId: null,
      favorite: false,
      reprompt: 0,
      key: null,
      name: encryptString(name, key),
      notes: enc(values.notes),
      fields: [],
      passwordHistory: [],
      login: {
        username: enc(values.username),
        password: enc(values.password),
        totp: enc(values.totp),
        uris: values.uri
          ? [
              {
                uri: encryptString(values.uri, key),
                uriChecksum: encryptString(sha256B64(values.uri), key),
                match: null,
              },
            ]
          : [],
      },
      secureNote: null,
      card: null,
      identity: null,
      sshKey: null,
    };
  }

  private profile(): Json {
    return {
      id: FAKE_USER_ID,
      email: FAKE_EMAIL,
      key: this.protectedKey,
      privateKey: this.privateKey,
      organizations: [
        {
          id: this.orgId,
          name: "Example org",
          key: this.orgConfirmed ? this.orgKeyForUser : null,
        },
      ],
      object: "profile",
    };
  }

  /** The cipher as this account sees it, with its collection permissions applied. */
  private view(cipher: Json): Json {
    const collections = this.collections.filter((c) => cipher.collectionIds.includes(c.id));
    const readOnly = collections.length > 0 && collections.every((c) => c.readOnly);
    const hidden = collections.length > 0 && collections.every((c) => c.hidePasswords);
    return { ...cipher, edit: !readOnly, viewPassword: !hidden };
  }

  private save(id: string, body: Json, previous: Json | null, collectionIds: string[]): Json {
    const stored: Json = {
      ...body,
      id,
      collectionIds,
      attachments: previous?.attachments ?? null,
      revisionDate: this.nextRevision(),
      deletedDate: null,
      object: "cipherDetails",
    };
    delete stored.encryptedFor;
    delete stored.lastKnownRevisionDate;
    this.ciphers.set(id, stored);
    return this.view(stored);
  }

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const path = url.pathname;
    this.requests.push(`${method} ${path}`);
    if (url.origin !== FAKE_SERVER) throw new TypeError("fetch failed");
    if (method === "GET" && path === "/api/config") {
      return json(200, {
        version: "2025.9.0",
        environment: this.environment ?? {
          vault: FAKE_SERVER,
          api: `${FAKE_SERVER}/api`,
          identity: `${FAKE_SERVER}/identity`,
        },
      });
    }
    if (method === "POST" && path === "/identity/connect/token") {
      if (this.rateLimitLogins)
        return json(429, { message: "Too many requests" }, { "retry-after": "30" });
      const form = new URLSearchParams(String(init.body));
      if (
        form.get("grant_type") !== "client_credentials" ||
        form.get("client_id") !== FAKE_CLIENT_ID ||
        form.get("client_secret") !== FAKE_CLIENT_SECRET
      ) {
        return json(400, { error: "invalid_client" });
      }
      this.logins += 1;
      const token = `token-${this.logins}`;
      this.tokens.add(token);
      return json(200, {
        access_token: token,
        expires_in: 7_200,
        token_type: "Bearer",
        Key: this.protectedKey,
      });
    }
    if (method === "POST" && path === "/identity/accounts/prelogin") {
      return json(200, { kdf: 0, kdfIterations: 5_000, kdfMemory: null, kdfParallelism: null });
    }
    if (path.startsWith("/attachments/")) {
      const file = this.files.get(path.split("/").pop()!);
      return file ? new Response(Buffer.from(file)) : json(404, {});
    }
    const auth = new Headers(init.headers).get("authorization") ?? "";
    if (!this.tokens.has(auth.replace(/^Bearer /, ""))) return json(401, {});

    if (method === "GET" && path === "/api/accounts/profile") return json(200, this.profile());
    if (method === "GET" && path === "/api/sync") {
      return json(200, {
        profile: this.profile(),
        collections: this.collections,
        ciphers: [...this.ciphers.values()].map((cipher) => this.view(cipher)),
        object: "sync",
      });
    }
    const body =
      typeof init.body === "string" && init.body ? (JSON.parse(init.body) as Json) : null;
    if (method === "POST" && (path === "/api/ciphers" || path === "/api/ciphers/create")) {
      const cipher = path === "/api/ciphers" ? body! : body!.cipher;
      // Vaultwarden 1.37 refuses cipher bodies without the account they are encrypted for.
      if (cipher.encryptedFor !== FAKE_USER_ID)
        return json(422, { message: "missing field `encryptedFor`" });
      const collectionIds: string[] = path === "/api/ciphers" ? [] : body!.collectionIds;
      if (collectionIds.some((id) => this.collections.find((c) => c.id === id)?.readOnly)) {
        return json(400, { message: "You do not have permissions to add to this collection." });
      }
      return json(200, this.save(randomUUID(), cipher, null, collectionIds));
    }
    const item = path.match(
      /^\/api\/ciphers\/([0-9a-f-]{36})(\/details|\/delete|\/attachment\/([^/]+))?$/,
    );
    if (item) {
      const stored = this.ciphers.get(item[1]!);
      if (!stored) return json(404, { message: "Cipher doesn't exist" });
      if (method === "GET" && item[2] === "/details") return json(200, this.view(stored));
      if (method === "GET" && item[3]) {
        const attachment = (stored.attachments ?? []).find((a: Json) => a.id === item[3]);
        return attachment ? json(200, attachment) : json(404, {});
      }
      if (method === "PUT" && item[2] === "/delete") {
        stored.deletedDate = this.nextRevision();
        return new Response(null, { status: 200 });
      }
      if (method === "PUT" && !item[2]) {
        if (body!.encryptedFor !== FAKE_USER_ID)
          return json(422, { message: "missing field `encryptedFor`" });
        if (!this.view(stored).edit) {
          return json(400, { message: "You do not have permissions to edit this." });
        }
        if (body!.lastKnownRevisionDate && body!.lastKnownRevisionDate !== stored.revisionDate) {
          return json(400, {
            message:
              "The client copy of this cipher is out of date. Resync the client and try again.",
          });
        }
        return json(200, this.save(stored.id, body!, stored, stored.collectionIds));
      }
    }
    return json(404, { message: `no route ${method} ${path}` });
  };
}
