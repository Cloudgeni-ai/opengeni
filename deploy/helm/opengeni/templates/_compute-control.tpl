{{/*
Opengeni compute's fleet service (computeControl): names and settings shared
by its Deployment, Services, hook Job and sweep.
*/}}
{{- define "opengeni.computeControl.name" -}}
{{- printf "%s-compute-control" (include "opengeni.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "opengeni.computeControl.serviceAccountName" -}}
{{- $sa := .Values.computeControl.serviceAccount -}}
{{- if $sa.create -}}
{{- default (include "opengeni.computeControl.name" .) $sa.name -}}
{{- else -}}
{{- default (include "opengeni.serviceAccountName" .) $sa.name -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.computeControl.image" -}}
{{- $image := .Values.computeControl.image -}}
{{- if not (or $image.tag $image.digest) -}}
{{- fail "computeControl.image.tag or computeControl.image.digest is required: compute releases are not tagged with the chart's appVersion" -}}
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
{{- end -}}

{{/* The database the service uses, as libpq key-value settings; the password
comes from $(COMPUTE_DATABASE_PASSWORD) in the container's environment. */}}
{{- define "opengeni.computeControl.databaseSettings" -}}
{{- $db := .Values.computeControl.database -}}
{{- $host := $db.host | default (include "opengeni.postgresHost" .) -}}
{{- $name := $db.name | default .Values.postgres.auth.database -}}
{{- printf "host=%s port=%v dbname=%s user=%s sslmode=%s" $host $db.port $name $db.role ($db.sslmode | default "disable") -}}
{{- end -}}

{{- define "opengeni.computeControl.assert" -}}
{{- $cc := .Values.computeControl -}}
{{- if not $cc.database.existingSecret -}}
{{- fail "computeControl.database.existingSecret is required" -}}
{{- end -}}
{{- if not $cc.keys.existingSecret -}}
{{- fail "computeControl.keys.existingSecret is required" -}}
{{- end -}}
{{- if not $cc.hostsTls.secretName -}}
{{- fail "computeControl.hostsTls.secretName is required: hosts and the service authenticate each other with TLS" -}}
{{- end -}}
{{- if and $cc.teamLinks (not $cc.link.existingSecret) -}}
{{- fail "computeControl.teamLinks needs computeControl.link.existingSecret, the key link tokens are signed with" -}}
{{- end -}}
{{- range $team, $url := $cc.teamLinks -}}
{{- if not (regexMatch "^wss://" $url) -}}
{{- fail (printf "computeControl.teamLinks.%s must be a wss:// URL" $team) -}}
{{- end -}}
{{- end -}}
{{- if not (regexMatch "^(gs|az|s3)://" ($cc.archive | default "")) -}}
{{- fail "computeControl.archive must be object storage (gs://, az:// or s3://)" -}}
{{- end -}}
{{- if and $cc.database.provision $cc.database.urlKey -}}
{{- fail "computeControl.database.provision makes the role and schema for the chart-built connection; leave urlKey empty, or set provision to false" -}}
{{- end -}}
{{- if not (regexMatch "^[a-z_][a-z0-9_]*$" $cc.database.role) -}}
{{- fail "computeControl.database.role must be a plain lowercase identifier" -}}
{{- end -}}
{{- if not (regexMatch "^[a-z_][a-z0-9_]*$" $cc.database.schema) -}}
{{- fail "computeControl.database.schema must be a plain lowercase identifier" -}}
{{- end -}}
{{- end -}}


{{/* The public API's host name: apiTls.host, or the Service's cluster name. */}}
{{- define "opengeni.computeControl.apiHost" -}}
{{- $tls := .Values.computeControl.apiTls -}}
{{- if $tls.host -}}
{{- $tls.host -}}
{{- else if $tls.secretName -}}
{{- printf "%s.%s.svc" (include "opengeni.computeControl.name" .) .Release.Namespace -}}
{{- else -}}
{{- include "opengeni.computeControl.name" . -}}
{{- end -}}
{{- end -}}

{{- define "opengeni.computeControl.apiUrl" -}}
{{- $scheme := ternary "https" "http" (not (empty .Values.computeControl.apiTls.secretName)) -}}
{{- printf "%s://%s:%d" $scheme (include "opengeni.computeControl.apiHost" .) (.Values.computeControl.service.apiPort | int) -}}
{{- end -}}

{{/* Opengeni's pods that call the fleet service (API, control and turn
workers) trust the authority of its API certificate. Each define is empty
unless the release runs the service with apiTls. */}}
{{- define "opengeni.computeControl.trusted" -}}
{{- if and .Values.computeControl.enabled .Values.computeControl.apiTls.secretName -}}true{{- end -}}
{{- end -}}

{{- define "opengeni.computeControl.trustEnv" -}}
{{- if include "opengeni.computeControl.trusted" . }}
- name: NODE_EXTRA_CA_CERTS
  value: /etc/opengeni/compute-control-ca/ca.crt
{{- end }}
{{- end -}}

{{- define "opengeni.computeControl.trustVolumeMount" -}}
{{- if include "opengeni.computeControl.trusted" . }}
- name: compute-control-ca
  mountPath: /etc/opengeni/compute-control-ca
  readOnly: true
{{- end }}
{{- end -}}

{{- define "opengeni.computeControl.trustVolume" -}}
{{- if include "opengeni.computeControl.trusted" . }}
- name: compute-control-ca
  secret:
    secretName: {{ .Values.computeControl.apiTls.secretName }}
    defaultMode: 0444
    items:
      - key: ca.crt
        path: ca.crt
{{- end }}
{{- end -}}
