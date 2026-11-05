---
"@opengeni/sdk": minor
"@opengeni/api-router": minor
---

The Excel add-in now moves whole workbooks both ways. `excel_run` takes two new optional parameters. `files` lists up to five chat artifactIds: the pane downloads them as the person and hands them to the code as `files[i]` (`artifactId`, `name`, `contentType`, `base64`), for `Excel.createWorkbook` or `insertWorksheetsFromBase64`. `saveCopyAs` names a copy: after the code runs, the pane reads the whole workbook with `Office.context.document.getFileAsync` (unsaved changes included), uploads it as the person, and the server publishes it to the chat with the chat's audience, so the result's `copy` carries an artifactId the agent can link. `code` is optional when only a copy is wanted. New `@opengeni/sdk/office` exports: `readWorkbookFile`, `workbookCopyFilename`, `XLSX_CONTENT_TYPE`, `OfficeRunFile`, `WorkbookFiles`, `WorkbookRunFile`, `WorkbookRunRequest` and `WorkbookRunResult`; `WorkbookLink` takes a `files` option (`download`, `upload`) and run code receives `files` as a fourth argument.
