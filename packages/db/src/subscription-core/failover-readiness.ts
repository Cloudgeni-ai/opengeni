import { sql } from "drizzle-orm";
import { rawRows, type Database } from "../database";
import {
  subscriptionCoreProvider,
  subscriptionCoreProviderIds,
} from "../subscription-core-providers";
import { readSubscriptionCoreProviderRoute } from "./provider-route";
import { subscriptionCoreConnectionKind, type SubscriptionCoreProvider } from "./provider";

/** Registry/receipt/route proof, never connection eligibility or authority.
 * The app role cannot SELECT the private registry or call its old invoker
 * kind lookup. The narrow definer exposes only kind + committed boolean.
 * Isolate a failed read in a savepoint: unreadable means closed, not legacy.
 */
export async function readSubscriptionCoreFailoverProvider(
  tx: Database,
  accountId: string,
  providerId: string,
): Promise<SubscriptionCoreProvider | null> {
  if (!subscriptionCoreProviderIds().includes(providerId)) return null;
  const provider = subscriptionCoreProvider(providerId);
  try {
    return await tx.transaction(async (scoped) => {
      const rows = await rawRows<{ connection_kind: string; committed: boolean }>(
        scoped,
        sql`
        select connection_kind, committed
        from opengeni_private.subscription_core_failover_readiness(${providerId})`,
      );
      if (
        rows.length !== 1 ||
        rows[0]!.committed !== true ||
        rows[0]!.connection_kind !== subscriptionCoreConnectionKind(provider)
      )
        return null;
      return (await readSubscriptionCoreProviderRoute(scoped, {
        accountId,
        provider: providerId,
      })) === "core"
        ? provider
        : null;
    });
  } catch {
    return null;
  }
}

/** D-46: absence is proven from keys, never from an index's spelling.
 * INCLUDE attributes are not keys. Partial/invalid unique indexes still
 * block crossing. Missing/ambiguous relation or attribute proof fails closed.
 * A failed catalog read rolls back its savepoint, not the placement world.
 */
export async function subscriptionCoreBindingsPermitCrossing(tx: Database): Promise<boolean> {
  try {
    return await tx.transaction(async (scoped) => {
      const rows = await rawRows<{ known: boolean; blocked: boolean }>(
        scoped,
        sql`
        with target as (
          select relation.oid, relation.relkind, namespace.nspname
          from pg_catalog.pg_class relation
          join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
          where relation.oid = pg_catalog.to_regclass('subscription_session_bindings')
        ), attributes as (
          select attribute.attnum from target
          join pg_catalog.pg_attribute attribute on attribute.attrelid = target.oid
          where attribute.attname in ('workspace_id', 'session_id')
            and attribute.attnum > 0 and not attribute.attisdropped
            and attribute.atttypid = 'uuid'::regtype and attribute.attnotnull
        ), provider_attribute as (
          select attribute.attnum from target
          join pg_catalog.pg_attribute attribute on attribute.attrelid = target.oid
          where attribute.attname = 'provider' and attribute.attnum > 0
            and not attribute.attisdropped and attribute.attnotnull
            and attribute.atttypid = 'text'::regtype
        )
        select (select count(*) = 1 from target where relkind = 'r'
            and nspname not like 'pg_temp_%' and nspname not like 'pg_toast%')
          and (select count(*) = 2 from attributes)
          and (select count(*) = 1 from provider_attribute)
          and exists (
            select 1 from target join pg_catalog.pg_index index on index.indrelid = target.oid
            where index.indisunique and index.indisvalid and index.indisready
              and index.indimmediate and index.indpred is null and index.indnkeyatts = 3
              and (select array_agg(key.attnum order by key.attnum)
                from unnest(index.indkey) with ordinality as key(attnum, position)
                where key.position <= index.indnkeyatts)
                = (select array_agg(attnum order by attnum) from (
                  select attnum from attributes union all select attnum from provider_attribute
                ) expected_keys)
          ) as known,
          exists (
            select 1 from target join pg_catalog.pg_index index on index.indrelid = target.oid
            where index.indisunique and index.indnkeyatts = 2
              and (select array_agg(key.attnum order by key.attnum)
                from unnest(index.indkey) with ordinality as key(attnum, position)
                where key.position <= index.indnkeyatts)
                = (select array_agg(attnum order by attnum) from attributes)
          ) as blocked`,
      );
      return rows.length === 1 && rows[0]!.known === true && rows[0]!.blocked === false;
    });
  } catch {
    return false;
  }
}
