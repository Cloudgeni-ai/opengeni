# Amazon Bedrock

A self-hosted Opengeni can run Claude on Amazon Bedrock in your own AWS account,
with credentials from the pod's AWS identity and no stored keys. Model traffic
goes from the worker to `bedrock-runtime` in the region you choose, or to your
VPC endpoint.

Opengeni sends the native Anthropic Messages format to Bedrock's
`/anthropic/v1/messages` route and signs each request with AWS Signature
Version 4. The Messages transport is the one used for Anthropic's API
([Native Claude Messages](./model-providers.md#native-claude-messages)), so
tool calls, adaptive thinking, prompt caching, images and streaming behave
the same way.

## Configure

| Variable | Meaning |
| --- | --- |
| `OPENGENI_BEDROCK_REGION` | Turns Bedrock on, for example `eu-west-1`. Requests, discovery and STS use this region. |
| `OPENGENI_BEDROCK_ENDPOINT_URL` | Optional `https://` `bedrock-runtime` endpoint, such as a VPC interface endpoint URL. |
| `OPENGENI_BEDROCK_MODELS` | Optional comma-separated inference profile ids (`eu.anthropic.claude-opus-5-5`, `global.anthropic.claude-sonnet-5-5`), model ids or inference-profile ARNs, including application inference profiles. `<application profile ARN>=<profile id>` names the model an application profile copies, for when discovery is off. |
| `OPENGENI_BEDROCK_MODEL_DISCOVERY` | `false` turns model discovery off. On by default. |
| `OPENGENI_BEDROCK_ATTRIBUTION_ROLE_ARN` | Optional per-user cost attribution (see below). |

Models are offered as `bedrock/<profile id>`, or `bedrock/application-inference-profile/<id>`
for an application profile. With discovery on, Opengeni lists the Claude models the
account offers in the region at startup and every 15 minutes
(`ListInferenceProfiles`, `ListFoundationModels`): system inference profiles
(`global.` and the region's geography), on-demand models and application
inference profiles. Discovery lists Claude models Opengeni has a native profile
for; `OPENGENI_BEDROCK_MODELS` adds others. A listed model can still be refused
if IAM or model access does not allow it.

For a Bedrock-only deployment, set the default and the allowed list to Bedrock
models. No OpenAI key is needed:

```sh
OPENGENI_BEDROCK_REGION=eu-west-1
OPENGENI_OPENAI_MODEL=bedrock/eu.anthropic.claude-opus-5-5
OPENGENI_OPENAI_ALLOWED_MODELS=bedrock/eu.anthropic.claude-opus-5-5,bedrock/eu.anthropic.claude-sonnet-5-5
```

A `bedrock/<profile id>` default works without listing it in
`OPENGENI_BEDROCK_MODELS`. Workspace and organization model access policy
applies to Bedrock models like any other deployment model.

## AWS identity on EKS

Credentials come from the AWS SDK default chain, in its order: environment
variables, shared config and profile (including SSO), web identity (IRSA),
container credentials (EKS Pod Identity, ECS task role) and the EC2 instance
role. The SDK refreshes temporary credentials before they expire, so long
sessions keep working. The API and worker pods use the chart's one service
account (`serviceAccount` in `deploy/helm/opengeni/values.yaml`).

- **IRSA:** create an IAM role trusted by the cluster's OIDC provider for
  `system:serviceaccount:<namespace>:<service account>` and set
  `serviceAccount.annotations."eks.amazonaws.com/role-arn"` to its ARN.
- **EKS Pod Identity:** install the Pod Identity Agent add-on and create a
  pod identity association for the namespace and service account. No
  annotation is needed.

The pod role needs this policy. Cross-region profiles run in several regions,
so the foundation-model resources use a wildcard region:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeClaude",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": [
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
        "arn:aws:bedrock:*:<account id>:inference-profile/*anthropic.claude-*",
        "arn:aws:bedrock:*:<account id>:application-inference-profile/*"
      ]
    },
    {
      "Sid": "ListModels",
      "Effect": "Allow",
      "Action": ["bedrock:ListInferenceProfiles", "bedrock:ListFoundationModels"],
      "Resource": "*"
    }
  ]
}
```

Without the `ListModels` statement, discovery fails (logged as a warning) and
only `OPENGENI_BEDROCK_MODELS` and a `bedrock/` default are offered. An
application profile is offered only once its base model is known, from
discovery or from `<ARN>=<profile id>` in `OPENGENI_BEDROCK_MODELS`, so it is
always priced. Anthropic models also need model access for the account (the
Anthropic use-case form and model agreement in the Bedrock console).

## Private networking

Create interface VPC endpoints for `com.amazonaws.<region>.bedrock-runtime`
(model calls), `com.amazonaws.<region>.bedrock` (discovery) and
`com.amazonaws.<region>.sts` (IRSA and attribution). With private DNS on, the
standard hostnames resolve to the endpoints and nothing else is needed. Without
private DNS, set `OPENGENI_BEDROCK_ENDPOINT_URL` to the runtime endpoint URL;
discovery and STS always use the standard regional hostnames, so turn discovery
off and list models in `OPENGENI_BEDROCK_MODELS` in that case.

## Per-user cost attribution

AWS records the caller of each Bedrock request in CUR 2.0's
`line_item_iam_principal` column when the data export includes **Include caller
identity (IAM principal) allocation data**. For an assumed role it is the session
ARN, including the session name
([AWS](https://aws.amazon.com/blogs/aws-cloud-financial-management/track-amazon-bedrock-costs-by-caller-identity-with-iam-based-cost-allocation/)).

With `OPENGENI_BEDROCK_ATTRIBUTION_ROLE_ARN` set, the worker assumes that role
from the pod role for each person and signs their requests with it, so each
request shows as
`arn:aws:sts::<account id>:assumed-role/<role name>/og-user-<user id>`. The
session name is `og-` and the person's stable Opengeni user id, never their
email; an id too long for STS's 64-character limit is replaced by a digest of
it. Sessions last an hour (the role-chaining limit) and are renewed before they
expire. Agent turns and chat titles a person started are attributed to them;
other model calls, and work started by no person (such as scheduled runs
without an initiating human), use the pod role. Converse `requestMetadata` is not used: it reaches
invocation logs, not CUR.

The attribution role carries the same `InvokeClaude` statement as above. Its
trust policy lets the pod role assume it:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<account id>:role/<pod role>" },
      "Action": "sts:AssumeRole",
      "Condition": { "StringLike": { "sts:RoleSessionName": "og-*" } }
    }
  ]
}
```

The pod role also needs `sts:AssumeRole` on the attribution role. If assuming it
fails or STS does not answer within 10 seconds, that person's request fails
with the role name and STS error; it does not fall back to the pod role.

## Prices, usage and residency

Usage is recorded at Bedrock's rate for the route: Anthropic's list price for
`global.` profiles, 10% more for geographic profiles (`eu.`, `us.`, …) and
in-Region model ids, and the rate of the profile an application profile copies.
`OPENGENI_MODEL_PRICING_JSON` overrides a price by product id, for example
for negotiated rates. Residency follows the profile: `eu.` profiles and EU
in-Region models are EU, `global.` profiles are global
([EU-only inference](./eu-only-inference.md)). An application profile is
unknown unless it copies a global profile.

## Not supported

- Models other than Claude. Bedrock's Converse API is not used, so Llama, Nova,
  Mistral and other vendors cannot be selected.
- Anthropic's server-side web search. Bedrock does not offer it; Opengeni's own
  web search tool still works when a web search provider is configured.
- AWS access keys or Bedrock API keys entered in Settings → Models. Bedrock is a
  deployment route that uses the pod's AWS identity.
- Batch inference, provisioned throughput and Bedrock Guardrails.
- Anthropic beta features Bedrock does not accept. If Bedrock refuses a beta
  flag, the request is sent once more without the flags its error names (all
  of them if it names none), and that model leaves them out for an hour.
- AWS China regions (`cn-*`).
