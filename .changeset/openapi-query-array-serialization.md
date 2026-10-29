---
"@opengeni/capabilities": patch
---

Honor OpenAPI form query arrays with explode:false, including Microsoft Graph $select, $expand and $orderby, instead of repeating the query option. Refresh existing integration catalogs to adopt the corrected immutable bindings; previously accepted revisions stay unchanged.
