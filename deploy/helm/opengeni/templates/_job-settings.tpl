{{/* Job settings are rendered with the incoming release, before its hook runs. */}}
{{- define "opengeni.jobConfigName" -}}
{{- printf "%s-%s-config" (include "opengeni.fullname" .root) .component -}}
{{- end -}}

{{- define "opengeni.jobRuntimeSecretName" -}}
{{- if .root.Values.secret.create -}}
{{- printf "%s-%s-runtime" (include "opengeni.fullname" .root) .component -}}
{{- else -}}
{{- include "opengeni.secretName" .root -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.jobMigrationSecretName" -}}
{{- if eq (include "opengeni.migrationSecretName" .root) (include "opengeni.secretName" .root) -}}
{{- include "opengeni.jobRuntimeSecretName" . -}}
{{- else -}}
{{- include "opengeni.migrationSecretName" .root -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.jobSettingsAnnotations" -}}
helm.sh/hook: {{ index . "helm.sh/hook" | quote }}
helm.sh/hook-weight: {{ sub (int (default "0" (index . "helm.sh/hook-weight"))) 1 | quote }}
# Helm removes successful hook resources after the whole event, not after
# creating this snapshot. Keep it through Job execution; replace it on retry.
helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
{{- end -}}
