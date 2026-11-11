---
"@opengeni/contracts": minor
"@opengeni/interaction": minor
"@opengeni/observability": patch
"@opengeni/runtime": patch
---

Browser operation metrics now tell a website that failed apart from a failure of the browser or its controller. When a page's server does not answer, its name does not resolve, the connection or TLS handshake fails, or it sends an unusable response, browserd sends an operator-only failure reason (`destination_not_answered`, `destination_name_not_resolved`, `destination_connection_failed`, `destination_tls_failed`, `destination_response_invalid`) beside the receipt or error, never inside it, so what callers and models are shown does not change. A generic `outcome_unknown` after input was sent now carries the specific failure behind it (such as `timeout`), and `outcome_unknown` operations are counted with their reason instead of `none`. `OpenGeniInteractionOperationFailureRatio` leaves website failures out of its ratio, so an agent retrying a site that is down no longer pages while browser, controller and authorization failures still do. New contracts exports: `INTERACTION_DESTINATION_FAILURE_REASONS`, `InteractionFailureReason`, `parseInteractionFailureReason` and `BROWSER_ACTION_RECEIPT_FAILURE_REASON_PARAMETER`; driver errors in `@opengeni/interaction` gain an optional `failureReason`.
