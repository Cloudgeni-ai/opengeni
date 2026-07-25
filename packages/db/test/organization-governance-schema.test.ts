import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  organizationAuthorizationInvalidations,
  organizationRecoveryApprovals,
  organizationRecoveryAudit,
  organizationRecoveryOperations,
} from "../src/schema";

describe("organization governance schema metadata", () => {
  test("keeps operation identity tenant-bound in every dependent table", () => {
    const expected = [
      {
        table: organizationRecoveryApprovals,
        name: "organization_recovery_approvals_operation_account_fk",
        onDelete: "cascade",
      },
      {
        table: organizationAuthorizationInvalidations,
        name: "organization_authorization_invalidations_operation_account_fk",
        onDelete: "restrict",
      },
      {
        table: organizationRecoveryAudit,
        name: "organization_recovery_audit_operation_account_fk",
        onDelete: "restrict",
      },
    ] as const;

    for (const item of expected) {
      const operationForeignKeys = getTableConfig(item.table).foreignKeys.filter((key) =>
        key.reference().columns.some((column) => column.name === "operation_id"),
      );
      expect(operationForeignKeys).toHaveLength(1);
      const foreignKey = operationForeignKeys[0]!;
      const reference = foreignKey.reference();
      expect(foreignKey.getName()).toBe(item.name);
      expect(foreignKey.onDelete).toBe(item.onDelete);
      expect(reference.columns.map((column) => column.name)).toEqual([
        "operation_id",
        "account_id",
      ]);
      expect(reference.foreignColumns.map((column) => column.name)).toEqual(["id", "account_id"]);
    }
  });

  test("declares the composite recovery-operation identity and one pending operation", () => {
    const config = getTableConfig(organizationRecoveryOperations);
    expect(config.uniqueConstraints.map((constraint) => constraint.getName())).toContain(
      "organization_recovery_operations_id_account_uq",
    );
    expect(
      config.indexes.some(
        (index) =>
          index.config.name === "organization_recovery_operations_one_pending_uq" &&
          index.config.unique &&
          index.config.where !== undefined,
      ),
    ).toBe(true);
  });
});
