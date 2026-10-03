output "capacity_contract" {
  description = "Sanitized intended bounds; live Ready capacity, quota, placement, and workload slots require separate evidence."
  value = {
    environment = var.environment
    cluster_id  = data.azurerm_kubernetes_cluster.existing.id
    system = {
      owner     = local.manages_system_pool ? "azure-aks-capacity" : "azure"
      vm_size   = "Standard_D4ds_v4"
      min_count = 4
      max_count = local.manages_system_pool ? 5 : 6
    }
    launch = {
      name      = azurerm_kubernetes_cluster_node_pool.launch.name
      vm_size   = azurerm_kubernetes_cluster_node_pool.launch.vm_size
      min_count = azurerm_kubernetes_cluster_node_pool.launch.min_count
      max_count = azurerm_kubernetes_cluster_node_pool.launch.max_count
      max_pods  = azurerm_kubernetes_cluster_node_pool.launch.max_pods
    }
  }
}