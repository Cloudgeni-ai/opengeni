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

{{- define "opengeni.priorityClassName" -}}
{{- $explicit := .explicit | default "" -}}
{{- if $explicit -}}
{{- $explicit -}}
{{- else if .root.Values.priorityClasses.enabled -}}
{{- printf "%s-%s" (include "opengeni.fullname" .root) .tier | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.image" -}}
{{- $registry := .root.Values.global.imageRegistry -}}
{{- $repository := .image.repository -}}
{{- if $registry -}}
{{- $repository = printf "%s/%s" ($registry | trimSuffix "/") .image.repository -}}
{{- end -}}
{{- $tag := .image.tag | default .root.Chart.AppVersion -}}
{{- if .image.digest -}}
{{- printf "%s:%s@%s" $repository $tag .image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repository $tag -}}
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

{{- define "opengeni.garageSecretName" -}}
{{- if .Values.garage.auth.existingSecret -}}
{{- .Values.garage.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-garage" (include "opengeni.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.assertExclusiveObjectStorageFixture" -}}
{{- if and .Values.garage.enabled .Values.minio.enabled -}}
{{- fail "Enable only one in-cluster object-storage fixture: set garage.enabled or minio.enabled, not both" -}}
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

{{- define "opengeni.minioInternalEndpoint" -}}
{{- printf "http://%s-minio:%d" (include "opengeni.fullname" .) (.Values.minio.service.apiPort | int) -}}
{{- end -}}

{{- define "opengeni.minioSandboxEndpoint" -}}
{{- if .Values.minio.sandboxEndpoint -}}
{{- .Values.minio.sandboxEndpoint -}}
{{- else -}}
{{- include "opengeni.minioEndpoint" . -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.garageEndpoint" -}}
{{- if .Values.garage.publicEndpoint -}}
{{- .Values.garage.publicEndpoint -}}
{{- else -}}
{{- printf "http://%s-garage:%d" (include "opengeni.fullname" .) (.Values.garage.service.apiPort | int) -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.garageInternalEndpoint" -}}
{{- printf "http://%s-garage:%d" (include "opengeni.fullname" .) (.Values.garage.service.apiPort | int) -}}
{{- end -}}

{{- define "opengeni.garageSandboxEndpoint" -}}
{{- if .Values.garage.sandboxEndpoint -}}
{{- .Values.garage.sandboxEndpoint -}}
{{- else -}}
{{- include "opengeni.garageEndpoint" . -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.objectStorageInternalEndpoint" -}}
{{- include "opengeni.assertExclusiveObjectStorageFixture" . -}}
{{- if .Values.garage.enabled -}}
{{- include "opengeni.garageInternalEndpoint" . -}}
{{- else if .Values.minio.enabled -}}
{{- include "opengeni.minioInternalEndpoint" . -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.objectStoragePublicEndpoint" -}}
{{- include "opengeni.assertExclusiveObjectStorageFixture" . -}}
{{- if .Values.garage.enabled -}}
{{- include "opengeni.garageEndpoint" . -}}
{{- else if .Values.minio.enabled -}}
{{- include "opengeni.minioEndpoint" . -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.objectStorageSandboxEndpoint" -}}
{{- include "opengeni.assertExclusiveObjectStorageFixture" . -}}
{{- if .Values.garage.enabled -}}
{{- include "opengeni.garageSandboxEndpoint" . -}}
{{- else if .Values.minio.enabled -}}
{{- include "opengeni.minioSandboxEndpoint" . -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.objectStorageSecretName" -}}
{{- if .Values.garage.enabled -}}
{{- include "opengeni.garageSecretName" . -}}
{{- else if .Values.minio.enabled -}}
{{- include "opengeni.minioSecretName" . -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.objectStorageAccessKeyKey" -}}
{{- if .Values.garage.enabled -}}
{{- .Values.garage.auth.accessKeyKey -}}
{{- else if .Values.minio.enabled -}}
{{- .Values.minio.auth.accessKeyKey -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.objectStorageSecretKeyKey" -}}
{{- if .Values.garage.enabled -}}
{{- .Values.garage.auth.secretKeyKey -}}
{{- else if .Values.minio.enabled -}}
{{- .Values.minio.auth.secretKeyKey -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.objectStorageBucket" -}}
{{- if .Values.garage.enabled -}}
{{- .Values.garage.bucket -}}
{{- else if .Values.minio.enabled -}}
{{- .Values.minio.bucket -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.objectStorageS3Provider" -}}
{{- if .Values.garage.enabled -}}
Other
{{- else if .Values.minio.enabled -}}
Minio
{{- end -}}
{{- end -}}

{{- define "opengeni.garageToml" -}}
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"

replication_factor = 1

rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = {{ .Values.garage.auth.rpcSecret | quote }}

[s3_api]
s3_region = "us-east-1"
api_bind_addr = "[::]:3900"
root_domain = ".s3.garage.localhost"

[s3_web]
bind_addr = "[::]:3902"
root_domain = ".web.garage.localhost"
index = "index.html"

[admin]
api_bind_addr = "127.0.0.1:3903"
{{- end -}}

{{- define "opengeni.generatedRuntimeEnv" -}}
{{- $root := . -}}
{{- $objectStorageEndpoint := "" -}}
{{- $includeDatabaseUrl := true -}}
{{- if hasKey . "root" -}}
{{- $root = .root -}}
{{- $objectStorageEndpoint = .objectStorageEndpoint -}}
{{- if hasKey . "includeDatabaseUrl" -}}
{{- $includeDatabaseUrl = .includeDatabaseUrl -}}
{{- end -}}
{{- else if $root.Values.garage.enabled -}}
{{- $objectStorageEndpoint = include "opengeni.objectStoragePublicEndpoint" $root -}}
{{- else if $root.Values.minio.enabled -}}
{{- $objectStorageEndpoint = include "opengeni.objectStoragePublicEndpoint" $root -}}
{{- end -}}
{{- if and $includeDatabaseUrl $root.Values.postgres.enabled }}
{{- if $root.Values.postgres.runtime.existingSecret }}
- name: OPENGENI_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ $root.Values.postgres.runtime.existingSecret }}
      key: {{ $root.Values.postgres.runtime.databaseUrlKey }}
{{- else }}
- name: OPENGENI_POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "opengeni.postgresSecretName" $root }}
      key: {{ $root.Values.postgres.auth.passwordKey }}
- name: OPENGENI_DATABASE_URL
  value: {{ printf "postgres://%s:$(OPENGENI_POSTGRES_PASSWORD)@%s:%d/%s" $root.Values.postgres.auth.username (include "opengeni.postgresHost" $root) ($root.Values.postgres.service.port | int) $root.Values.postgres.auth.database | quote }}
{{- end }}
{{- end }}
{{- if $root.Values.temporal.enabled }}
- name: OPENGENI_TEMPORAL_HOST
  value: {{ printf "%s-temporal:%d" (include "opengeni.fullname" $root) ($root.Values.temporal.service.port | int) | quote }}
{{- end }}
{{- include "opengeni.assertExclusiveObjectStorageFixture" $root }}
{{- if or $root.Values.garage.enabled $root.Values.minio.enabled }}
- name: OPENGENI_OBJECT_STORAGE_ENDPOINT
  value: {{ $objectStorageEndpoint | quote }}
- name: OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT
  value: {{ include "opengeni.objectStorageInternalEndpoint" $root | quote }}
- name: OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT
  value: {{ include "opengeni.objectStorageSandboxEndpoint" $root | quote }}
- name: OPENGENI_OBJECT_STORAGE_BACKEND
  value: s3-compatible
- name: OPENGENI_OBJECT_STORAGE_BUCKET
  value: {{ include "opengeni.objectStorageBucket" $root | quote }}
- name: OPENGENI_OBJECT_STORAGE_REGION
  value: "us-east-1"
- name: OPENGENI_OBJECT_STORAGE_S3_PROVIDER
  value: {{ include "opengeni.objectStorageS3Provider" $root | quote }}
- name: OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE
  value: "true"
- name: OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "opengeni.objectStorageSecretName" $root }}
      key: {{ include "opengeni.objectStorageAccessKeyKey" $root }}
- name: OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "opengeni.objectStorageSecretName" $root }}
      key: {{ include "opengeni.objectStorageSecretKeyKey" $root }}
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
