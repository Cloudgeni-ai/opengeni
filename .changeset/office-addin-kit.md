---
"@opengeni/sdk": minor
"@opengeni/config": patch
---

Products that embed Opengeni can ship their own branded Excel add-in. The new `@opengeni/sdk/office` entry point has the add-in kit Opengeni's own add-in is built from: the manifest, the workbook link that lets agents run Office.js in the open workbook, Excel theme and selection watchers, per-message workbook and selection context, and a sign-in dialog helper. `createOfficeWorkbookTicket` and `listOfficeWorkbooks` connect and list workbooks per workspace.

A connected workbook now belongs to one person in one workspace, so agents reach it only from that workspace, and products whose users share one credential stay isolated. The ticket and list routes moved under `/v1/workspaces/{workspaceId}/office/`. `OPENGENI_OFFICE_ADDIN_NAME` and `OPENGENI_OFFICE_ADDIN_INSTALL_URL` set the add-in name and install link agents give when no workbook is connected.
