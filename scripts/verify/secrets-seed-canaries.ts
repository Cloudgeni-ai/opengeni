#!/usr/bin/env bun
/**
 * Seed the gate canaries (dossier §13B.2): items `Canary`, `Canary TOTP`,
 * `Rotating` and `CanaryFile` in the owner's default vault, each with a fresh
 * `OGCANARY-<uuid>` value, and write the list to a 0600 canaries file that the
 * sweep reads and deletes afterwards.
 *
 *   bun --no-env-file scripts/verify/secrets-seed-canaries.ts --stack sv-w7 \
 *     --out .agent/evidence/canaries.json [--user owner] [--workspace "Platform engineering"]
 *
 * Exit 3 when the vault API is not present on the stack yet (missing feature).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { randomTotpSecret } from "../../packages/testing/src/fake-login/totp";
import { type CanaryFile, newCanaryValue, writeCanaryFile } from "./secrets-e2e/scan";
import { DEFAULT_WORKSPACE, type SeedUser, StackApi, loadStack } from "./secrets-e2e/stack";
import { VaultClient } from "./secrets-e2e/vault-client";

export class MissingFeatureError extends Error {}

export async function seedCanaries(api: StackApi, workspaceId: string): Promise<CanaryFile> {
  const vaults = new VaultClient(api, workspaceId);
  const listed = await vaults.listVaults();
  if (listed.status === 404) {
    throw new MissingFeatureError(`vault API missing: GET /vaults -> ${listed.status}`);
  }
  if (!listed.ok) throw new Error(`GET /vaults -> ${listed.status}: ${listed.text.slice(0, 300)}`);
  const rows: any[] = listed.json?.vaults ?? [];
  const vault =
    rows.find((row) => row.ownerKind === "user" && row.isDefault) ??
    rows.find((row) => row.ownerKind === "user");
  if (!vault) throw new Error("the seed user has no Only-me vault to hold canaries");

  const canary = newCanaryValue();
  const rotating = newCanaryValue();
  const fileValue = newCanaryValue();
  const totpSeed = randomTotpSecret();
  const items = [
    { name: "Canary", type: "api_key", field: "credential", kind: "concealed", value: canary },
    {
      name: "Canary TOTP",
      type: "login",
      field: "one-time password",
      kind: "totp",
      value: totpSeed,
    },
    { name: "Rotating", type: "api_key", field: "credential", kind: "concealed", value: rotating },
    { name: "CanaryFile", type: "file", field: "file", kind: "file", value: fileValue },
  ] as const;
  const file: CanaryFile = {
    createdAt: new Date().toISOString(),
    stack: api.stack.name,
    values: [],
  };
  for (const item of items) {
    const created = await vaults.createItem(vault.id, {
      type: item.type,
      name: item.name,
      fields: [{ name: item.field, kind: item.kind, value: item.value }],
    });
    if (!created.ok) {
      throw new Error(`create ${item.name} -> ${created.status}: ${created.text.slice(0, 300)}`);
    }
    file.values.push({
      label: item.name,
      value: item.value,
      item: created.json?.id ?? created.json?.item?.id,
      field: item.field,
      reference: `{{secret:${item.name}}}`,
    });
  }
  return file;
}

async function main(): Promise<number> {
  const { values: flags } = parseArgs({
    options: {
      stack: { type: "string" },
      out: { type: "string" },
      user: { type: "string", default: "owner" },
      workspace: { type: "string", default: DEFAULT_WORKSPACE },
    },
  });
  if (!flags.stack || !flags.out) {
    console.error("usage: secrets-seed-canaries.ts --stack <name> --out <canaries.json>");
    return 2;
  }
  const stack = loadStack(flags.stack);
  if (!stack) {
    console.error(`stack ${flags.stack} is not running`);
    return 2;
  }
  const api = new StackApi(stack, flags.user as SeedUser);
  try {
    const file = await seedCanaries(api, await api.workspaceId(flags.workspace));
    mkdirSync(dirname(flags.out), { recursive: true });
    writeCanaryFile(flags.out, file);
    console.log(
      `seeded ${file.values.map((value) => value.label).join(", ")} -> ${flags.out} (0600)`,
    );
    return 0;
  } catch (error) {
    console.error((error as Error).message);
    return error instanceof MissingFeatureError ? 3 : 1;
  }
}

if (import.meta.main) process.exit(await main());
