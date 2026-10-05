locals {
  # Generated passwords contain no URI-reserved characters. Owner credentials
  # are never in a serving identity's secret list, even indirectly through RBAC.
  database_host = azurerm_postgresql_flexible_server.this.fqdn
  secret_values = merge({
    "application-db-url" = "postgresql://${local.runtime_database_role}:${random_password.database["app"].result}@${local.database_host}:5432/opengeni?sslmode=require"
    "migration-db-url"   = "postgresql://opengeni_owner:${random_password.database["owner"].result}@${local.database_host}:5432/opengeni?sslmode=require"
    "app-db-password"    = random_password.database["app"].result
    "blob-account-key"   = azurerm_storage_account.this.primary_access_key
    }, var.outbox_dispatcher_enabled ? {
    "outbox-db-url"      = "postgresql://${local.outbox_database_role}:${random_password.database["outbox"].result}@${local.database_host}:5432/opengeni?sslmode=require"
    "outbox-db-password" = random_password.database["outbox"].result
  } : {}, { for name, secret in var.secret_env : name => secret.value })
  secret_names = {
    for key in nonsensitive(toset(keys(local.secret_values))) :
    key => startswith(key, "OPENGENI_") || can(regex("^[A-Z]", key)) ? "s-${substr(sha256(key), 0, 16)}" : key
  }
  application_secret_keys = {
    for role in local.serving_roles : role => setunion(toset(["application-db-url", "blob-account-key"]), toset([
      for name in nonsensitive(toset(keys(var.secret_env))) : name if contains(nonsensitive(var.secret_env[name].roles), role)
    ]))
  }
  migration_secret_keys = setunion(
    toset(["migration-db-url", "application-db-url", "app-db-password", "blob-account-key"]),
    var.outbox_dispatcher_enabled ? toset(["outbox-db-password"]) : toset([]),
    contains(nonsensitive(keys(var.secret_env)), "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY") ? toset(["OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY"]) : toset([])
  )
  outbox_secret_keys = setunion(
    var.outbox_dispatcher_enabled ? toset(["outbox-db-url"]) : toset([]),
    toset([for name in ["OPENGENI_NATS_URL", "OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD"] : name if contains(nonsensitive(keys(var.secret_env)), name)])
  )
  role_secret_keys = merge(local.application_secret_keys, {
    migration = local.migration_secret_keys
    web       = toset([])
  }, var.outbox_dispatcher_enabled ? { outbox = local.outbox_secret_keys } : {})
  secret_grants = {
    for grant in flatten([
      for role, keys in local.role_secret_keys : [for key in keys : { role = role, key = key }]
    ]) : "${grant.role}/${grant.key}" => grant
  }
  application_secret_env = {
    for role, keys in local.application_secret_keys : role => merge({
      OPENGENI_DATABASE_URL                     = "application-db-url"
      OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY = "blob-account-key"
    }, { for key in keys : key => key if contains(nonsensitive(keys(var.secret_env)), key) })
  }
}

resource "azurerm_key_vault" "this" {
  name                       = "${local.compact_prefix}kv${random_id.suffix.hex}"
  resource_group_name        = azurerm_resource_group.this.name
  location                   = var.location
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  purge_protection_enabled   = var.key_vault_purge_protection_enabled
  soft_delete_retention_days = 7
  tags                       = local.tags
}

# The applying principal manages ONLY this root's vault secrets, not any
# subscription-wide data-plane roles or existing vaults.
resource "azurerm_role_assignment" "secret_writer" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_key_vault_secret" "this" {
  for_each     = local.secret_names
  name         = each.value
  value        = local.secret_values[each.key]
  key_vault_id = azurerm_key_vault.this.id
  tags         = local.tags

  depends_on = [azurerm_role_assignment.secret_writer]
}

resource "azurerm_role_assignment" "secret_reader" {
  for_each             = local.secret_grants
  scope                = "${azurerm_key_vault.this.id}/secrets/${azurerm_key_vault_secret.this[each.value.key].name}"
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.workload[each.value.role].principal_id
  principal_type       = "ServicePrincipal"
}