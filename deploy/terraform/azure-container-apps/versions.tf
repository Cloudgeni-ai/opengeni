terraform {
  required_version = ">= 1.13.0, < 2.0.0"

  # Supply an absolute, private path at init. A production thin wrapper can
  # consume this directory as a module and select its own locked remote backend.
  backend "local" {}

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "= 4.72.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "= 3.7.2"
    }
    azapi = {
      source  = "Azure/azapi"
      version = "= 2.13.0"
    }
  }
}

provider "azapi" {
  skip_provider_registration = true
  enable_preflight           = false
}

# Register the documented resource providers separately, with the operator's
# authority. Applying this root must not register unrelated subscription RPs.
provider "azurerm" {
  resource_provider_registrations = "none"

  features {
    key_vault {
      purge_soft_delete_on_destroy    = false
      recover_soft_deleted_key_vaults = false
    }
    resource_group {
      prevent_deletion_if_contains_resources = true
    }
  }
}