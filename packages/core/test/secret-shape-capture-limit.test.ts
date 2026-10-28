/**
 * The task-vault capture limit holds under parallel captures: a slot is
 * reserved before each create, so captures running at the same time never
 * pass the limit together (docs/secrets.md, Masking). Fake values only.
 */
import { describe, expect, test } from "bun:test";
import type { SecretPrincipal, SecretShapeMatch } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import {
  createTaskVaultSecretCapturer,
  SECRET_SHAPE_CAPTURED_ITEMS_MAX,
  type VaultService,
} from "../src/domain/vaults";

const REF_OPEN = "\u007B\u007Bsecret:";
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function fakeService(existing: number) {
  let items = existing;
  const allowed: boolean[] = [];
  const service = {
    async countTaskVaultItemsForAgent() {
      await tick();
      return items;
    },
    async captureForAgent(
      _principal: SecretPrincipal,
      input: { item: string; field: string; createAllowed?: boolean },
    ) {
      allowed.push(input.createAllowed === true);
      await tick();
      if (!input.createAllowed) throw new Error("capture limit reached");
      items += 1;
      return {
        created: true,
        byField: { [input.field]: `${REF_OPEN}Task/${input.item}/${input.field}}}` },
      };
    },
  } as unknown as VaultService;
  return { service, allowed, count: () => items };
}

const principal = { kind: "attempt" } as Extract<SecretPrincipal, { kind: "attempt" }>;

function urlPasswords(count: number): SecretShapeMatch[] {
  return Array.from({ length: count }, (_, index) => {
    const value = `FAKE-pw-${String(index).padStart(4, "0")}-x`;
    return { kind: "url-password", start: 0, end: value.length, value };
  });
}

describe("task-vault capture limit", () => {
  test("parallel captures one below the limit create exactly one item", async () => {
    const fake = fakeService(SECRET_SHAPE_CAPTURED_ITEMS_MAX - 1);
    const capture = createTaskVaultSecretCapturer({
      db: {} as Database,
      encryptionKey: new Uint8Array(32).fill(7),
      principal,
      service: fake.service,
    });
    const references = await capture(urlPasswords(4));
    expect(fake.count()).toBe(SECRET_SHAPE_CAPTURED_ITEMS_MAX);
    expect(fake.allowed.filter(Boolean)).toHaveLength(1);
    expect(references.size).toBe(1);
  });

  test("below the limit every parallel capture may create", async () => {
    const fake = fakeService(0);
    const capture = createTaskVaultSecretCapturer({
      db: {} as Database,
      encryptionKey: new Uint8Array(32).fill(7),
      principal,
      service: fake.service,
    });
    const references = await capture(urlPasswords(8));
    expect(references.size).toBe(8);
    expect(fake.count()).toBe(8);
  });
});
