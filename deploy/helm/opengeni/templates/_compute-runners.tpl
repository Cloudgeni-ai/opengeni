{{/*
GitHub Actions runner pools on Opengeni compute (computeRunners): names and
settings shared by the pools' Deployments, Services and NetworkPolicy.
*/}}
{{- define "opengeni.computeRunners.name" -}}
{{- printf "%s-compute-runners" (include "opengeni.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* A pool's Deployment and Service: dict "root" "pool". */}}
{{- define "opengeni.computeRunners.poolName" -}}
{{- printf "%s-runners-%s" (include "opengeni.fullname" .root) .pool.name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "opengeni.computeRunners.serviceAccountName" -}}
{{- $sa := .Values.computeRunners.serviceAccount -}}
{{- if $sa.create -}}
{{- default (include "opengeni.computeRunners.name" .) $sa.name -}}
{{- else -}}
{{- default (include "opengeni.serviceAccountName" .) $sa.name -}}
{{- end -}}
{{- end -}}

{{/* The pools run `compute-runners`, which the compute control image
carries: its own image only when computeRunners.image names one. */}}
{{- define "opengeni.computeRunners.image" -}}
{{- $image := .Values.computeRunners.image -}}
{{- if $image.repository -}}
{{- if not (or $image.tag $image.digest) -}}
{{- fail "computeRunners.image.tag or computeRunners.image.digest is required with computeRunners.image.repository" -}}
{{- end -}}
{{- $registry := .Values.global.imageRegistry -}}
{{- $repository := $image.repository -}}
{{- if $registry -}}
{{- $repository = printf "%s/%s" ($registry | trimSuffix "/") $image.repository -}}
{{- end -}}
{{- if and $image.tag $image.digest -}}
{{- printf "%s:%s@%s" $repository $image.tag $image.digest -}}
{{- else if $image.digest -}}
{{- printf "%s@%s" $repository $image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repository $image.tag -}}
{{- end -}}
{{- else -}}
{{- include "opengeni.computeControl.image" . -}}
{{- end -}}
{{- end -}}

{{/* Compute's E2B front door as the pools reach it, in the cluster. */}}
{{- define "opengeni.computeRunners.computeUrl" -}}
{{- $cc := .Values.computeControl -}}
{{- $scheme := ternary "https" "http" (not (empty $cc.apiTls.secretName)) -}}
{{- printf "%s://%s:%d" $scheme (include "opengeni.computeControl.apiHost" .) (int64 $cc.e2b.port) -}}
{{- end -}}

{{- define "opengeni.computeRunners.assert" -}}
{{- $cc := .Values.computeControl -}}
{{- if not (and $cc.enabled $cc.e2b.enabled) -}}
{{- fail "computeRunners.pools need computeControl.enabled and computeControl.e2b.enabled: pools reach compute through its E2B front door" -}}
{{- end -}}
{{- $seen := dict -}}
{{- range .Values.computeRunners.pools -}}
{{- $name := toString (.name | default "") -}}
{{- if not (regexMatch "^[a-z0-9][a-z0-9-]{0,39}$" $name) -}}
{{- fail (printf "computeRunners.pools: name %q must be 1 to 40 lowercase letters, digits and -, starting with a letter or digit" $name) -}}
{{- end -}}
{{- if hasKey $seen $name -}}
{{- fail (printf "computeRunners.pools: two pools are named %q" $name) -}}
{{- end -}}
{{- $_ := set $seen $name true -}}
{{- if not .scope -}}
{{- fail (printf "computeRunners.pools.%s.scope is required: an organization, or owner/repo" $name) -}}
{{- end -}}
{{- if not .template -}}
{{- fail (printf "computeRunners.pools.%s.template is required: a computeControl.e2b.templates id" $name) -}}
{{- end -}}
{{- if not (.github).existingSecret -}}
{{- fail (printf "computeRunners.pools.%s.github.existingSecret is required: a token (tokenKey), or an App's private key (appKeyKey) with appId" $name) -}}
{{- end -}}
{{- if ne (empty (.github).appId) (empty (.github).appInstallation) -}}
{{- fail (printf "computeRunners.pools.%s.github needs both appId and appInstallation, or neither" $name) -}}
{{- end -}}
{{- if not (.compute).existingSecret -}}
{{- fail (printf "computeRunners.pools.%s.compute.existingSecret is required: a key of computeControl.keys" $name) -}}
{{- end -}}
{{- with .cache -}}
{{- if not (regexMatch "^(gs|s3|az)://" (.store | default "")) -}}
{{- fail (printf "computeRunners.pools.%s.cache.store must be object storage (gs://, s3:// or az://)" $name) -}}
{{- end -}}
{{- if not (regexMatch "^https?://[^/?#]+" (.url | default "")) -}}
{{- fail (printf "computeRunners.pools.%s.cache.url is required: the cache's address as runners, outside the cluster, reach it" $name) -}}
{{- end -}}
{{- if not .existingSecret -}}
{{- fail (printf "computeRunners.pools.%s.cache.existingSecret is required: the token runners give the cache" $name) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
