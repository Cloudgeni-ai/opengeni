/**
 * Registration of a test-only provider on the shared subscription core, for
 * the conformance harness (design docs/design/subscription-core-2026-10-07.md,
 * 5.3 step F). It performs, inside one test process and on one test
 * database, exactly the registration a real provider's step ships:
 *
 * - TypeScript: an entry in the provider registry
 *   (`subscription-core-providers.ts`) and in the personal-authority v2
 *   provider list (`@opengeni/contracts`). `testSubscriptionCoreProviderModules`
 *   returns the replacement modules, which delegate every other lookup to the
 *   real ones; the test file itself installs them with `mock.module` before
 *   the runtime modules are first imported, so the process-global patch is
 *   visible where it happens (and the CI shard classifier runs that file in
 *   its own process).
 * - SQL (on the test database, as its owner): the provider's registry row
 *   with its connection kind, its cutover receipt, and the provider id added
 *   to every provider list a migration widens for a new provider (the table
 *   CHECK constraints and the personal-authority routines that still
 *   enumerate providers).
 *
 * Production gains nothing: no provider row, table, route or registry entry.
 */
import type { Sql } from "postgres";
import { z } from "zod";
import * as realContracts from "@opengeni/contracts";
import * as realAuthority from "@opengeni/contracts/subscription-personal-authority-v2";
import * as realRegistry from "../../src/subscription-core-providers";
import type { SubscriptionCoreProvider } from "../../src/subscription-core/provider";
import { subscriptionCoreConnectionKind } from "../../src/subscription-core/provider";

/** The provider list every migration so far has used; a new id is appended to it. */
const LAST_LISTED_PROVIDER = "xai";

const registeredForTests = new Map<string, SubscriptionCoreProvider>();

/**
 * The modules that register `binding` in this test process's provider
 * registry and personal-authority provider list, as `[specifier, factory]`
 * pairs for `mock.module`. The registry specifier is absolute.
 */
export function testSubscriptionCoreProviderModules(
  binding: SubscriptionCoreProvider,
): Array<[string, () => Record<string, unknown>]> {
  const id = binding.adapter.provider;
  if (realRegistry.subscriptionCoreProviderIds().includes(id)) {
    throw new Error("A test provider must not reuse a registered provider id");
  }
  registeredForTests.set(id, binding);
  const realIds = realRegistry.subscriptionCoreProviderIds;
  const realProvider = realRegistry.subscriptionCoreProvider;
  const lookup = (providerId: string): SubscriptionCoreProvider => {
    const test = registeredForTests.get(providerId);
    return test ?? realProvider(providerId);
  };
  const listed = realAuthority.SubscriptionPersonalAuthorityV2.shape.personal.element.shape.provider
    .options as readonly string[];
  const widened = z
    .object({
      version: z.literal(2),
      personal: z
        .array(
          z
            .object({
              provider: z
                .string()
                .refine((value) => listed.includes(value) || registeredForTests.has(value)),
              ownerMembershipId:
                realAuthority.SubscriptionPersonalAuthorityV2.shape.personal.element.shape
                  .ownerMembershipId,
              authorityGeneration:
                realAuthority.SubscriptionPersonalAuthorityV2.shape.personal.element.shape
                  .authorityGeneration,
            })
            .strict(),
        )
        .max(listed.length + registeredForTests.size),
    })
    .strict()
    .superRefine((snapshot, ctx) => {
      const providers = snapshot.personal.map((authority) => authority.provider);
      if (new Set(providers).size !== providers.length) {
        ctx.addIssue({ code: "custom", message: "Duplicate provider personal authority" });
      }
    });
  return [
    [
      Bun.resolveSync("../../src/subscription-core-providers", import.meta.dir),
      () => ({
        ...realRegistry,
        subscriptionCoreProviderIds: () => [...realIds(), ...registeredForTests.keys()].sort(),
        subscriptionCoreProvider: lookup,
        subscriptionCoreAdapter: (providerId: string) => lookup(providerId).adapter,
      }),
    ],
    // Runtime modules import the schema from the package index or its subpath.
    [
      "@opengeni/contracts/subscription-personal-authority-v2",
      () => ({ ...realAuthority, SubscriptionPersonalAuthorityV2: widened }),
    ],
    ["@opengeni/contracts", () => ({ ...realContracts, SubscriptionPersonalAuthorityV2: widened })],
  ];
}

/**
 * Admit a test provider on one test database, as its owner: the registry row
 * and the provider lists a real provider's migration widens. Returns the
 * names of every constraint and routine it widened, so a test can assert the
 * list a real connector's migration must cover.
 */
export async function admitTestSubscriptionCoreProvider(
  admin: Sql,
  binding: SubscriptionCoreProvider,
): Promise<{ constraints: string[]; routines: string[] }> {
  const provider = binding.adapter.provider;
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(provider)) throw new Error("Test provider id is malformed");
  const listed = `'${LAST_LISTED_PROVIDER}'`;
  const widenedList = `'${LAST_LISTED_PROVIDER}', '${provider}'`;
  const constraints: string[] = [];
  const routines: string[] = [];
  await admin.begin(async (tx) => {
    const checks = await tx<{ relation: string; name: string; definition: string }[]>`
      select conrelid::regclass::text as relation, conname as name,
        pg_get_constraintdef(oid) as definition
      from pg_constraint
      where contype = 'c' and pg_get_constraintdef(oid) like ${`%${listed}::text]%`}
      order by 1, 2`;
    // Only provider lists (`= ANY (ARRAY[..., 'xai'::text])`) gain the id;
    // a constraint about one named provider is left alone.
    for (const check of checks) {
      const definition = check.definition.replaceAll(
        `${listed}::text]`,
        `${listed}::text, '${provider}'::text]`,
      );
      await tx.unsafe(
        `alter table ${check.relation} drop constraint ${check.name}, ` +
          `add constraint ${check.name} ${definition}`,
      );
      constraints.push(`${check.relation}.${check.name}`);
    }
    // Routines that still enumerate providers. The v2 validator always does;
    // the placement helper did until cutover receipts replaced its list.
    for (const [routine, required] of [
      ["public.subscription_personal_authority_v2_valid(jsonb)", true],
      [
        "opengeni_private.authorize_subscription_personal_placement_access(uuid, uuid, uuid, uuid, text, uuid, bigint, text, text)",
        false,
      ],
    ] as const) {
      const [row] = await tx<{ definition: string }[]>`
        select pg_get_functiondef(${routine}::regprocedure) as definition`;
      const anchor = `${listed})`;
      const occurrences = row!.definition.split(anchor).length - 1;
      if (occurrences === 0 && !required) continue;
      if (occurrences !== 1) throw new Error(`${routine} provider list changed`);
      await tx.unsafe(row!.definition.replace(anchor, `${widenedList})`));
      routines.push(routine);
    }
    await tx`
      insert into opengeni_private.subscription_core_providers
        (provider, extra_credits, primary_setting_column, connection_kind)
      values (${provider}, ${binding.adapter.capabilities.extraCredits},
        ${binding.settings.primaryColumn}, ${subscriptionCoreConnectionKind(binding)})`;
    // The provider's committed cutover, where receipts gate core rows.
    const [receipts] = await tx<{ present: boolean }[]>`
      select to_regclass('opengeni_private.subscription_provider_cutover_receipts') is not null
        as present`;
    if (receipts!.present) {
      await tx`
        insert into opengeni_private.subscription_provider_cutover_receipts
          (provider, migration, committed_at, seed_rotation)
        values (${provider}, '9999_conformance_test_provider.sql', clock_timestamp(),
          '{"mode":"spread"}'::jsonb)`;
      routines.push("opengeni_private.subscription_provider_cutover_receipts (receipt row)");
    }
  });
  return { constraints, routines };
}
