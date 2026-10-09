import { sql } from "drizzle-orm";
import type { Database } from "./database";

/** These catalog bindings form one protocol. A missing birth trigger is not
 * evidence that a command belongs to the legacy population. */
export function nativeCommandQualificationTriggerBindings(targetSchema: string) {
  return [
    {
      schema: "opengeni_private",
      relation: "native_command_qualifications",
      name: "native_command_qualification_guard",
      functionSchema: "opengeni_private",
      functionName: "native_command_qualification_guard",
      type: 31, // BEFORE ROW INSERT/UPDATE/DELETE
      updateColumns: [] as string[],
      securityDefiner: false,
    },
    ...[
      ["native_command_group_births", "native_command_birth_immutable"],
      ["native_command_provider_enrollments", "native_command_enrollment_immutable"],
      ["native_command_provider_bindings", "native_command_binding_immutable"],
    ].map(([relation, name]) => ({
      schema: "opengeni_private",
      relation: relation!,
      name: name!,
      functionSchema: "opengeni_private",
      functionName: "native_command_receipt_immutable",
      type: 27, // BEFORE ROW UPDATE/DELETE
      updateColumns: [] as string[],
      securityDefiner: false,
    })),
    {
      schema: targetSchema,
      relation: "sessions",
      name: "freeze_native_command_group_birth",
      functionSchema: targetSchema,
      functionName: "freeze_native_command_group_birth",
      type: 5, // AFTER ROW INSERT
      updateColumns: [] as string[],
      securityDefiner: true,
    },
    {
      schema: targetSchema,
      relation: "sandbox_leases",
      name: "freeze_native_command_provider_enrollment",
      functionSchema: targetSchema,
      functionName: "freeze_native_command_provider_enrollment",
      type: 17, // AFTER ROW UPDATE OF the canonical create/warm fields
      updateColumns: ["liveness", "provider_create_attempt"],
      securityDefiner: true,
    },
  ];
}

export type NativeCommandQualificationTrigger = {
  schema: string;
  relation: string;
  name: string;
  enabled: string;
  functionSchema: string;
  functionName: string;
  functionArguments: string;
  type: number;
  updateColumns: string[];
  unconditional: boolean;
  noArguments: boolean;
  internal: boolean;
  nonDeferred: boolean;
  relationOwner: string;
  functionOwner: string;
  securityDefiner: boolean;
  configuration: string[] | null;
};

export async function inspectNativeCommandQualificationTriggers(
  db: Pick<Database, "execute">,
  targetSchema?: string,
): Promise<NativeCommandQualificationTrigger[]> {
  const result = await db.execute<NativeCommandQualificationTrigger>(sql`
    select n.nspname::text as schema, c.relname::text as relation, t.tgname::text as name,
      t.tgenabled::text as enabled, fn.nspname::text as "functionSchema",
      p.proname::text as "functionName", pg_catalog.oidvectortypes(p.proargtypes) as "functionArguments",
      t.tgtype::integer as type,
      array(select a.attname::text from pg_catalog.pg_attribute a
        where a.attrelid = t.tgrelid and a.attnum = any(t.tgattr::smallint[])
        order by a.attname) as "updateColumns",
      t.tgqual is null as unconditional, t.tgnargs = 0 as "noArguments",
      t.tgisinternal as internal,
      (t.tgconstraint = 0 and not t.tgdeferrable and not t.tginitdeferred) as "nonDeferred",
      pg_catalog.pg_get_userbyid(c.relowner)::text as "relationOwner",
      pg_catalog.pg_get_userbyid(p.proowner)::text as "functionOwner",
      p.prosecdef as "securityDefiner", p.proconfig as configuration
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_proc p on p.oid = t.tgfoid
    join pg_catalog.pg_namespace fn on fn.oid = p.pronamespace
    where (n.nspname = 'opengeni_private' and t.tgname in (
      'native_command_qualification_guard', 'native_command_birth_immutable',
      'native_command_enrollment_immutable', 'native_command_binding_immutable'))
      or (n.nspname = coalesce(${targetSchema ?? null}, current_schema()) and t.tgname in (
        'freeze_native_command_group_birth', 'freeze_native_command_provider_enrollment'))
    order by n.nspname, t.tgname, c.relname
  `);
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows))
    throw new Error("Native command qualification catalog returned an unsupported result shape");
  return rows as NativeCommandQualificationTrigger[];
}

export function evaluateNativeCommandQualificationTriggers(
  triggers: readonly NativeCommandQualificationTrigger[],
  targetSchema: string,
): string[] {
  const violations: string[] = [];
  for (const expected of nativeCommandQualificationTriggerBindings(targetSchema)) {
    const matches = triggers.filter(
      (candidate) => candidate.schema === expected.schema && candidate.name === expected.name,
    );
    const trigger = matches[0];
    if (
      matches.length !== 1 ||
      !trigger ||
      trigger.relation !== expected.relation ||
      !["O", "A"].includes(trigger.enabled) ||
      trigger.functionSchema !== expected.functionSchema ||
      trigger.functionName !== expected.functionName ||
      trigger.functionArguments !== "" ||
      trigger.type !== expected.type ||
      trigger.updateColumns.length !== expected.updateColumns.length ||
      [...trigger.updateColumns].sort().some((column, i) => column !== expected.updateColumns[i]) ||
      !trigger.unconditional ||
      !trigger.noArguments ||
      trigger.internal ||
      !trigger.nonDeferred ||
      !trigger.relationOwner ||
      trigger.relationOwner !== trigger.functionOwner ||
      trigger.securityDefiner !== expected.securityDefiner ||
      trigger.configuration?.filter((value) => value.startsWith("search_path=")).join() !==
        "search_path=pg_catalog"
    ) {
      violations.push(
        `Native command qualification trigger ${expected.schema}.${expected.name} is missing or unsafe`,
      );
    }
  }
  return violations;
}

/** No cache: qualified birth/create/admission must fail closed after catalog
 * drift, including for groups with no frozen birth receipt. */
export async function assertNativeCommandQualificationReady(
  db: Pick<Database, "execute">,
): Promise<void> {
  const [schema] = await db.execute<{ name: string }>(sql`select current_schema() as name`);
  if (!schema?.name) throw new Error("Native command qualification data schema is unavailable");
  const violations = evaluateNativeCommandQualificationTriggers(
    await inspectNativeCommandQualificationTriggers(db, schema.name),
    schema.name,
  );
  if (violations.length)
    throw new Error(`Native command qualification is unavailable: ${violations.join("; ")}`);
}
