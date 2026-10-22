---
"@opengeni/core": minor
"@opengeni/react": minor
"@opengeni/runtime": patch
---

The Excel add-in now has its own Capabilities tile, "Microsoft Excel". The tile explains the add-in, shows the three setup steps and links to the deployment's install page. It uses the deployment's own add-in name and install URL (`OPENGENI_OFFICE_ADDIN_NAME`, `OPENGENI_OFFICE_ADDIN_INSTALL_URL`).

Agents can find it with `capability_catalog_search` (excel, spreadsheet, xlsx) and post its install card with `capability_authorization_request` (`api:excel-addin`). The card reports ready when the person already has a workbook open with the add-in. `excel_run` and the spreadsheets Skill tell agents to offer the add-in when someone works on a spreadsheet and no workbook is connected. `excelAddin`, `excelAddinCatalogItem` and `EXCEL_ADDIN_CAPABILITY_ID` are exported from `@opengeni/core`.
