terraform {
  required_version = ">= 1.13.0"

  backend "azurerm" {}

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "= 4.72.0"
    }
  }
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}