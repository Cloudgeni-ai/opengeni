{{/* Workload-local EnvVars must not shadow chart-owned role/identity/service entries. */}}
{{- define "opengeni.extraEnv" -}}
{{- if not (kindIs "slice" .entries) -}}
{{- fail "extraEnv must be a list of Kubernetes EnvVar objects" -}}
{{- end -}}
{{- $reserved := dict "OPENGENI_DEPLOYMENT_REVISION" true -}}
{{- range .reserved -}}
{{- $_ := set $reserved . true -}}
{{- end -}}
{{- $generated := include "opengeni.generatedRuntimeEnv" .root | trim -}}
{{- if $generated -}}
{{- range (fromYamlArray $generated) -}}
{{- $_ := set $reserved .name true -}}
{{- end -}}
{{- end -}}
{{- $seen := dict -}}
{{- range .entries -}}
{{- if not (kindIs "map" .) -}}
{{- fail "extraEnv entries must be Kubernetes EnvVar objects" -}}
{{- end -}}
{{- if or (not (kindIs "string" .name)) (not (regexMatch "^[A-Za-z_][A-Za-z0-9_]*$" .name)) -}}
{{- fail "extraEnv requires a valid environment variable name" -}}
{{- end -}}
{{- if or (hasKey $reserved .name) (hasKey $seen .name) -}}
{{- fail "extraEnv cannot repeat a variable or override chart-owned environment entries" -}}
{{- end -}}
{{- if or (ne (len .) 2) (eq (hasKey . "value") (hasKey . "valueFrom")) -}}
{{- fail "extraEnv entries require exactly one of value or valueFrom" -}}
{{- end -}}
{{- if and (hasKey . "value") (not (kindIs "string" .value)) -}}
{{- fail "extraEnv literal values must be strings" -}}
{{- end -}}
{{- if and (hasKey . "valueFrom") (not (kindIs "map" .valueFrom)) -}}
{{- fail "extraEnv valueFrom must be a Kubernetes EnvVarSource object" -}}
{{- end -}}
{{- $_ := set $seen .name true -}}
{{- end -}}
{{- if .entries -}}
{{ toYaml .entries }}
{{- end -}}
{{- end -}}