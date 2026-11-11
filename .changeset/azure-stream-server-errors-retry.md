---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

A model stream that ends with a temporary provider server error now retries the same turn instead of failing it. Azure OpenAI reports a mid-stream failure as an `error` event whose `type` names the HTTP status (`server_error` for 500, `too_many_requests` for 429) beside an open-ended specific `code`. An unrecognized code now defers to that documented status type, and Azure's service codes (`ServiceUnavailable`, `InternalServerError`, `BadGateway`, `GatewayTimeout`) and bare `500`/`502`/`503`/`504` codes are recognized. Safety, request and quota codes still stop the turn (Azure `DeploymentNotFound` and `model_not_found`, `invalid_value` and `unsupported_parameter` are now recognized request codes), and message wording alone still never triggers a retry. A streamed failure that does stop the turn now records the provider's bounded error code and type (`providerErrorCode`, `providerErrorType`) on `turn.failed`.
