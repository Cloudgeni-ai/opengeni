output "resource_group_name" {
  value = azurerm_resource_group.this.name
}

output "api_url" {
  description = "Public same-origin native ACA route; available as a planned URL during bootstrap."
  value       = local.api_url
}

output "web_url" {
  value = local.web_url
}

output "migration_job_name" {
  value = azurerm_container_app_job.migration.name
}

output "infrastructure_resource_group_name" {
  description = "Azure-managed ACA infrastructure resource group; include it in cleanup verification."
  value       = local.infrastructure_rg
}

output "environment" {
  value = {
    id             = azurerm_container_app_environment.this.id
    name           = azurerm_container_app_environment.this.name
    default_domain = azurerm_container_app_environment.this.default_domain
    vnet_id        = azurerm_virtual_network.this.id
    subnet_id      = azurerm_subnet.aca.id
  }
}

output "endpoints" {
  description = "Planned stable origins, available during bootstrap. They are not evidence that apps are running."
  value = {
    api          = local.api_url
    api_internal = local.api_internal_url
    web          = local.web_url
    mcp          = "${local.api_url}/v1/workspaces/{workspaceId}/mcp"
  }
}

output "migration_job" {
  description = "A manual job definition, never executed by Terraform. Confirm execution Succeeded before setting migration_completed_revision."
  value = {
    id                  = azurerm_container_app_job.migration.id
    name                = azurerm_container_app_job.migration.name
    resource_group_name = azurerm_resource_group.this.name
    image               = var.images.api
    application_roles   = local.migration_database_roles
    start_command       = "az containerapp job start --resource-group ${azurerm_resource_group.this.name} --name ${azurerm_container_app_job.migration.name}"
  }
}

output "secret_references" {
  description = "Created Key Vault secret reference IDs only; no credential values. State/plans remain sensitive."
  value       = { for key, secret in azurerm_key_vault_secret.this : key => secret.versionless_id }
}

output "workload_identities" {
  value = { for role, identity in azurerm_user_assigned_identity.workload : role => {
    id           = identity.id
    principal_id = identity.principal_id
    client_id    = identity.client_id
  } }
}

output "postgres" {
  value = {
    id              = azurerm_postgresql_flexible_server.this.id
    fqdn            = azurerm_postgresql_flexible_server.this.fqdn
    database        = azurerm_postgresql_flexible_server_database.opengeni.name
    app_role        = local.runtime_database_role
    migration_owner = azurerm_postgresql_flexible_server.this.administrator_login
  }
}

output "blob_storage" {
  value = {
    account_name = azurerm_storage_account.this.name
    container    = azurerm_storage_container.files.name
    endpoint     = azurerm_storage_account.this.primary_blob_endpoint
    cors_origins = [local.web_url]
  }
}

output "acr" {
  value = var.create_acr ? {
    id           = azurerm_container_registry.this[0].id
    name         = azurerm_container_registry.this[0].name
    login_server = azurerm_container_registry.this[0].login_server
  } : null
}

output "log_analytics_workspace_id" {
  value = azurerm_log_analytics_workspace.this.id
}

output "serving_app_ids" {
  value = merge({ for role, app in azurerm_container_app.service : role => app.id }, {
    for web in azurerm_container_app.web : "web" => web.id
  })
}

output "runtime_nonsecret_env" {
  description = "Server configuration only; credential values are never output. secret_env overrides are omitted from this common projection."
  value       = { for name, value in local.application_config_env : name => value if !contains(nonsensitive(keys(var.secret_env)), name) }
}

output "edge_route" {
  value = var.deployment_phase == "apps" ? {
    id                 = azapi_resource.edge[0].id
    name               = local.edge_name
    expected_fqdn      = local.edge_fqdn
    reported_fqdn      = try(azapi_resource.edge[0].output.properties.fqdn, null)
    provisioning_state = try(azapi_resource.edge[0].output.properties.provisioningState, null)
  } : null
}