import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeState } from "./fake-pass-cli";

export const VALID_TOKEN = "pst_0123456789abcdef::c2VjcmV0LWtleS1ub3QtcmVhbA";
export const TOTP_SEED = "JBSWY3DPEHPK3PXP";

function loginItem(id: string, shareId: string, title: string, modify = "2026-10-15T09:00:00") {
  return {
    id,
    share_id: shareId,
    vault_id: `v-${shareId}`,
    content: {
      title,
      note: "",
      item_uuid: "a1b2c3d4",
      content: {
        Login: {
          email: "",
          username: "alice",
          password: "pw-123",
          urls: ["https://login.example.test"],
          totp_uri: `otpauth://totp/Example:alice?secret=${TOTP_SEED}&issuer=Example`,
          passkeys: [],
          autofill_urls: [],
        },
      },
      extra_fields: [
        { name: "recovery code", content: { Hidden: "rc-1" } },
        { name: "otp", content: { Text: "not-a-seed" } },
        { name: "renewal", content: { Timestamp: 1_760_000_000 } },
      ],
      platform_specific: null,
      custom_icon: null,
    },
    state: "Active",
    flags: [],
    create_time: "2026-10-01T08:00:00",
    modify_time: modify,
  };
}

export function defaultState(): FakeState {
  return {
    version: "2.4.2",
    token: VALID_TOKEN,
    tokenName: "opengeni-ci",
    agent: false,
    shares: [
      { id: "rwShare==", name: "OpenGeni Test RW", share_type: "Vault", share_role: "Owner" },
      { id: "roShare==", name: "OpenGeni Test RO", share_type: "Vault", share_role: "Viewer" },
      {
        id: "customShare",
        name: "Custom role",
        share_type: "Vault",
        share_role: { Custom: { name: "reader+create", permission: 2 | 4 } },
      },
    ],
    items: {
      "rwShare==": [
        loginItem("loginItem1", "rwShare==", "Test Login"),
        {
          id: "customItem1",
          share_id: "rwShare==",
          vault_id: "v-rwShare==",
          content: {
            title: "Deploy key",
            note: "rotate quarterly",
            item_uuid: "x",
            content: {
              Custom: {
                sections: [
                  {
                    section_name: "Fields",
                    section_fields: [
                      { name: "value", content: { Hidden: "sk_live_1" } },
                      { name: "value", content: { Hidden: "sk_live_2" } },
                    ],
                  },
                ],
              },
            },
            extra_fields: [],
            platform_specific: null,
            custom_icon: null,
          },
          state: "Active",
          flags: ["ItemHasFiles"],
          create_time: "2026-10-01T08:00:00",
          modify_time: "2026-10-02T08:00:00",
        },
        {
          id: "trashedItem",
          share_id: "rwShare==",
          vault_id: "v-rwShare==",
          content: {
            title: "Old",
            note: "gone",
            item_uuid: "y",
            content: { Note: null },
            extra_fields: [],
          },
          state: "Trashed",
          flags: [],
          create_time: "2026-10-01T08:00:00",
          modify_time: "2026-10-01T08:00:00",
        },
      ],
      "roShare==": [loginItem("roLogin1", "roShare==", "Shared Login")],
      customShare: [],
    },
    attachments: {
      customItem1: [
        {
          id: "att1",
          size: 5,
          content: { name: "cert.pem", mime_type: "application/x-pem-file" },
          data: Buffer.from("hello").toString("base64"),
        },
        {
          id: "attBig",
          size: 300_000,
          content: { name: "big.bin", mime_type: "application/octet-stream" },
          data: "",
        },
      ],
    },
    failures: [],
  };
}

export type FakeCli = {
  dir: string;
  binaryPath: string;
  stateRoot: string;
  state(): FakeState;
  update(change: (state: FakeState) => void): void;
  log(): Array<{
    argv: string[];
    envNames: string[];
    home: string;
    sessionDir: string;
    path: string;
    reason: string | null;
    patPresent: boolean;
    stdin: string;
  }>;
  cleanup(): void;
};

export function makeFakeCli(change?: (state: FakeState) => void): FakeCli {
  const dir = mkdtempSync(join(tmpdir(), "og-fake-pass-"));
  const statePath = join(dir, "state.json");
  const state = defaultState();
  change?.(state);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  const binaryPath = join(dir, "pass-cli");
  const script = join(import.meta.dir, "fake-pass-cli.ts");
  writeFileSync(
    binaryPath,
    `#!${process.execPath}\nprocess.env.FAKE_PASS_STATE = ${JSON.stringify(statePath)};\nawait import(${JSON.stringify(script)});\n`,
  );
  chmodSync(binaryPath, 0o755);
  const read = () => JSON.parse(readFileSync(statePath, "utf8")) as FakeState;
  return {
    dir,
    binaryPath,
    stateRoot: join(dir, "state"),
    state: read,
    update(fn) {
      const current = read();
      fn(current);
      writeFileSync(statePath, JSON.stringify(current, null, 2));
    },
    log() {
      try {
        return readFileSync(`${statePath}.log`, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
