---
"@opengeni/config": minor
"@opengeni/runtime": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/worker-bundle": minor
---

Run Claude on Amazon Bedrock with the deployment's AWS identity: set `OPENGENI_BEDROCK_REGION` to use the native Messages transport against Bedrock, with `eu.`/`us.`/`global.` inference profiles, inference-profile ARNs, model discovery, Bedrock pricing and opt-in per-user cost attribution through an assumed role. The deployment model credential source (`ModelCredentialSourceV1` `mechanism`) gains the value `aws_iam`; clients that switch on it should treat unknown values as a deployment credential. While Bedrock is on, `OPENGENI_MODEL_PROVIDERS_JSON` cannot use the provider id `bedrock`.
