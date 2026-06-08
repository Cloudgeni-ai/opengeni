{{- define "opengeni.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "opengeni.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "opengeni.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "opengeni.selectorLabels" -}}
app.kubernetes.io/name: {{ include "opengeni.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "opengeni.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "opengeni.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.image" -}}
{{- $registry := .root.Values.global.imageRegistry -}}
{{- $repository := .image.repository -}}
{{- if $registry -}}
{{- $repository = printf "%s/%s" ($registry | trimSuffix "/") .image.repository -}}
{{- end -}}
{{- if .image.digest -}}
{{- printf "%s:%s@%s" $repository .image.tag .image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repository .image.tag -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.secretName" -}}
{{- if .Values.secret.create -}}
{{- printf "%s-runtime" (include "opengeni.fullname" .) -}}
{{- else -}}
{{- .Values.secret.existingSecret -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.migrationSecretName" -}}
{{- if .Values.migrations.secret.existingSecret -}}
{{- .Values.migrations.secret.existingSecret -}}
{{- else -}}
{{- include "opengeni.secretName" . -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.postgresSecretName" -}}
{{- if .Values.postgres.auth.existingSecret -}}
{{- .Values.postgres.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-postgres" (include "opengeni.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.temporalPostgresSecretName" -}}
{{- if .Values.temporal.postgres.existingSecret -}}
{{- .Values.temporal.postgres.existingSecret -}}
{{- else -}}
{{- include "opengeni.postgresSecretName" . -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.minioSecretName" -}}
{{- if .Values.minio.auth.existingSecret -}}
{{- .Values.minio.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-minio" (include "opengeni.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.postgresHost" -}}
{{- printf "%s-postgres" (include "opengeni.fullname" .) -}}
{{- end -}}

{{- define "opengeni.temporalPostgresHost" -}}
{{- if .Values.temporal.postgres.host -}}
{{- .Values.temporal.postgres.host -}}
{{- else -}}
{{- include "opengeni.postgresHost" . -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.minioEndpoint" -}}
{{- if .Values.minio.publicEndpoint -}}
{{- .Values.minio.publicEndpoint -}}
{{- else -}}
{{- printf "http://%s-minio:%d" (include "opengeni.fullname" .) (.Values.minio.service.apiPort | int) -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.minioSandboxEndpoint" -}}
{{- if .Values.minio.sandboxEndpoint -}}
{{- .Values.minio.sandboxEndpoint -}}
{{- else -}}
{{- include "opengeni.minioEndpoint" . -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.generatedRuntimeEnv" -}}
{{- if .Values.postgres.enabled }}
- name: OPENGENI_POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "opengeni.postgresSecretName" . }}
      key: {{ .Values.postgres.auth.passwordKey }}
- name: OPENGENI_DATABASE_URL
  value: {{ printf "postgres://%s:$(OPENGENI_POSTGRES_PASSWORD)@%s:%d/%s" .Values.postgres.auth.username (include "opengeni.postgresHost" .) (.Values.postgres.service.port | int) .Values.postgres.auth.database | quote }}
{{- end }}
{{- if .Values.temporal.enabled }}
- name: OPENGENI_TEMPORAL_HOST
  value: {{ printf "%s-temporal:%d" (include "opengeni.fullname" .) (.Values.temporal.service.port | int) | quote }}
{{- end }}
{{- if .Values.minio.enabled }}
- name: OPENGENI_OBJECT_STORAGE_ENDPOINT
  value: {{ include "opengeni.minioEndpoint" . | quote }}
- name: OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT
  value: {{ include "opengeni.minioSandboxEndpoint" . | quote }}
- name: OPENGENI_OBJECT_STORAGE_BACKEND
  value: s3-compatible
- name: OPENGENI_OBJECT_STORAGE_BUCKET
  value: {{ .Values.minio.bucket | quote }}
- name: OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "opengeni.minioSecretName" . }}
      key: {{ .Values.minio.auth.accessKeyKey }}
- name: OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "opengeni.minioSecretName" . }}
      key: {{ .Values.minio.auth.secretKeyKey }}
{{- end }}
{{- end -}}

{{- define "opengeni.topologySpreadConstraints" -}}
{{- $root := .root -}}
{{- $component := .component -}}
{{- $values := .values -}}
{{- if $values.topologySpreadConstraints.enabled }}
- maxSkew: {{ $values.topologySpreadConstraints.maxSkew }}
  topologyKey: {{ $values.topologySpreadConstraints.topologyKey | quote }}
  whenUnsatisfiable: {{ $values.topologySpreadConstraints.whenUnsatisfiable }}
  labelSelector:
    matchLabels:
      {{- include "opengeni.selectorLabels" $root | nindent 6 }}
      app.kubernetes.io/component: {{ $component }}
{{- end }}
{{- end -}}

{{- define "opengeni.httpProbe" -}}
{{- $probe := .probe -}}
httpGet:
  path: {{ $probe.path | quote }}
  port: http
initialDelaySeconds: {{ $probe.initialDelaySeconds | default 0 }}
periodSeconds: {{ $probe.periodSeconds | default 10 }}
timeoutSeconds: {{ $probe.timeoutSeconds | default 1 }}
failureThreshold: {{ $probe.failureThreshold | default 3 }}
{{- end -}}
