{{/*
Opengeni compute's control service (computeControl): names and settings shared
by its Deployment, Services, database Job and sweep.
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

{{/* The database the service uses, as libpq key-value settings, each value
quoted; the password is not among them: the service and its database wait
read it from their own environment variable, so any password works. */}}
{{- define "opengeni.computeControl.databaseSettings" -}}
{{- $db := .Values.computeControl.database -}}
{{- $host := $db.host | default (include "opengeni.postgresHost" .) -}}
{{- $name := $db.name | default .Values.postgres.auth.database -}}
{{- $settings := list (list "host" $host) (list "port" (toString $db.port)) (list "dbname" $name) (list "user" $db.role) (list "sslmode" ($db.sslmode | default "disable")) -}}
{{- $quoted := list -}}
{{- range $settings -}}
{{- $value := index . 1 | replace "\\" "\\\\" | replace "'" "\\'" -}}
{{- $quoted = append $quoted (printf "%s='%s'" (index . 0) $value) -}}
{{- end -}}
{{- join " " $quoted -}}
{{- end -}}

{{/* Whether the service's database is the chart's own Postgres, the one
the migration owner URL reaches: the chart runs Postgres and neither
database.host nor database.name names another. */}}
{{- define "opengeni.computeControl.ownDatabase" -}}
{{- $db := .Values.computeControl.database -}}
{{- if and .Values.postgres.enabled (not (or $db.host $db.name)) -}}true{{- end -}}
{{- end -}}

{{/*
The database password's revision, a whole number that each change of the
password raises: it rolls the service's pods, and orders the database Jobs
that give the role a password, so that an earlier one cannot undo a later.
*/}}
{{- define "opengeni.computeControl.passwordRevision" -}}
{{- $revision := .Values.computeControl.database.passwordRevision | default 0 -}}
{{- /* A number in values arrives as a float: one with a fraction would
round to a revision another value also gives. */ -}}
{{- if kindIs "float64" $revision -}}
{{- if ne $revision (float64 (int64 $revision)) -}}
{{- fail "computeControl.database.passwordRevision must be a whole number, raised at each change of the password" -}}
{{- end -}}
{{- $revision = int64 $revision -}}
{{- end -}}
{{- $revision = toString $revision -}}
{{- if not (regexMatch "^[0-9]{1,15}$" $revision) -}}
{{- fail "computeControl.database.passwordRevision must be a whole number, raised at each change of the password" -}}
{{- end -}}
{{- $revision -}}
{{- end -}}

{{- define "opengeni.computeControl.assert" -}}
{{- $cc := .Values.computeControl -}}
{{- if not $cc.database.existingSecret -}}
{{- fail "computeControl.database.existingSecret is required" -}}
{{- end -}}
{{- $_ := include "opengeni.computeControl.passwordRevision" . -}}
{{- if not $cc.keys.existingSecret -}}
{{- fail "computeControl.keys.existingSecret is required" -}}
{{- end -}}
{{- if not $cc.hostsTls.secretName -}}
{{- fail "computeControl.hostsTls.secretName is required: the hosts' certificate authority (ca.crt, ca.key)" -}}
{{- end -}}
{{- if not (regexMatch "^https://[^/?#]+/?$" ($cc.hostUrl | default "")) -}}
{{- fail "computeControl.hostUrl must be the https:// URL hosts reach the service at, such as https://compute-control.example.com:8443" -}}
{{- end -}}
{{- if ne (empty $cc.hostIdentity.gcpProject) (empty $cc.hostIdentity.gcpAccount) -}}
{{- fail "computeControl.hostIdentity needs both gcpProject and gcpAccount, or neither" -}}
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
{{- if and (not $cc.database.urlKey) (not .Values.postgres.enabled) (not $cc.database.host) -}}
{{- fail "computeControl.database.host is required when the chart runs no Postgres (postgres.enabled is false), or give a whole connection string with database.urlKey" -}}
{{- end -}}
{{- if and $cc.database.provision (not (include "opengeni.computeControl.ownDatabase" .)) -}}
{{- fail "computeControl.database.provision makes the role and schema in the chart's own Postgres, with the migration owner URL; for any other database set provision to false and make them there (compute/docs/operations.md, The control service)" -}}
{{- end -}}
{{- if and $cc.sweep.enabled (not (regexMatch "^gs://" ($cc.archive | default ""))) -}}
{{- fail "computeControl.sweep deletes only from Google Cloud Storage archives (ADR 17); set sweep.enabled to false for az:// and s3:// archives" -}}
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

{{/* Opengeni's pods that call the control service (API, control and turn
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
