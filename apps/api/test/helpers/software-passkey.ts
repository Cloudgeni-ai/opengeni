import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

/**
 * A minimal software WebAuthn authenticator for tests: one ES256 (P-256)
 * discoverable credential with "none" attestation, user presence and user
 * verification. It answers the JSON options the server sends exactly as a
 * browser's `navigator.credentials` JSON form would.
 */
export type SoftwarePasskey = {
  credentialId: string;
  userHandle: string | null;
  counter: number;
  privateKey: KeyObject;
  publicKey: KeyObject;
};

type Flags = { userPresent?: boolean; userVerified?: boolean; backedUp?: boolean };

function flagsByte(flags: Flags, attested: boolean): number {
  let value = 0;
  if (flags.userPresent !== false) value |= 0x01;
  if (flags.userVerified !== false) value |= 0x04;
  if (flags.backedUp) value |= 0x08 | 0x10;
  if (attested) value |= 0x40;
  return value;
}

function rpIdHash(rpId: string): Buffer {
  return createHash("sha256").update(rpId).digest();
}

function counterBytes(counter: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(counter);
  return bytes;
}

function clientData(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

export function createSoftwarePasskey(): SoftwarePasskey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    credentialId: isoBase64URL.fromBuffer(randomBytes(32)),
    userHandle: null,
    counter: 0,
    privateKey,
    publicKey,
  };
}

/** Answer registration options (`navigator.credentials.create`). */
export function softwarePasskeyRegistration(
  passkey: SoftwarePasskey,
  options: Record<string, unknown>,
  input: { origin: string; aaguid?: string; flags?: Flags; rpId?: string },
): Record<string, unknown> {
  const rp = options.rp as { id: string };
  const user = options.user as { id: string };
  passkey.userHandle = user.id;
  const jwk = passkey.publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const cosePublicKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, isoBase64URL.toBuffer(jwk.x)],
      [-3, isoBase64URL.toBuffer(jwk.y)],
    ]),
  );
  const credentialId = isoBase64URL.toBuffer(passkey.credentialId);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(credentialId.length);
  const aaguid = Buffer.from(
    (input.aaguid ?? "00000000-0000-0000-0000-000000000000").replaceAll("-", ""),
    "hex",
  );
  const authData = Buffer.concat([
    rpIdHash(input.rpId ?? rp.id),
    Buffer.from([flagsByte(input.flags ?? {}, true)]),
    counterBytes(passkey.counter),
    aaguid,
    length,
    Buffer.from(credentialId),
    Buffer.from(cosePublicKey),
  ]);
  const attestationObject = isoCBOR.encode(
    new Map<string, unknown>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", new Uint8Array(authData)],
    ]) as never,
  );
  return {
    id: passkey.credentialId,
    rawId: passkey.credentialId,
    type: "public-key",
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(
        clientData("webauthn.create", options.challenge as string, input.origin),
      ),
      attestationObject: isoBase64URL.fromBuffer(attestationObject),
      transports: ["internal", "hybrid"],
    },
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  };
}

/** Answer sign-in options (`navigator.credentials.get`). */
export function softwarePasskeyAssertion(
  passkey: SoftwarePasskey,
  options: Record<string, unknown>,
  input: { origin: string; flags?: Flags; rpId?: string; counter?: number },
): Record<string, unknown> {
  passkey.counter = input.counter ?? passkey.counter + 1;
  const authenticatorData = Buffer.concat([
    rpIdHash(input.rpId ?? (options.rpId as string)),
    Buffer.from([flagsByte(input.flags ?? {}, false)]),
    counterBytes(passkey.counter),
  ]);
  const clientDataJSON = clientData("webauthn.get", options.challenge as string, input.origin);
  const signature = sign(
    "sha256",
    Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]),
    passkey.privateKey,
  );
  return {
    id: passkey.credentialId,
    rawId: passkey.credentialId,
    type: "public-key",
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
      authenticatorData: isoBase64URL.fromBuffer(authenticatorData),
      signature: isoBase64URL.fromBuffer(signature),
      ...(passkey.userHandle ? { userHandle: passkey.userHandle } : {}),
    },
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  };
}
