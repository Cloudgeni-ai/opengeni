{{/*
Runtime database password files (runtimeDatabasePasswordFiles). When enabled,
the api, worker-control and worker-turns pods mount two optional keys of the
runtime Secret as files and read the runtime login's password from them on
every new connection, so the password can be rotated without a restart:

  OPENGENI_DATABASE_PASSWORD          -> /var/run/opengeni/database/password
  OPENGENI_DATABASE_PREVIOUS_PASSWORD -> /var/run/opengeni/database/previous-password

The volume is optional and mounted as a directory (never subPath, which would
not receive kubelet updates). While the keys are absent the files are missing
and the pods use the password in OPENGENI_DATABASE_URL, exactly as before.
*/}}
{{- define "opengeni.databasePasswordFiles.enabled" -}}
{{- if (.Values.runtimeDatabasePasswordFiles).enabled -}}true{{- end -}}
{{- end -}}

{{- define "opengeni.databasePasswordFiles.mountPath" -}}
/var/run/opengeni/database
{{- end -}}

{{- define "opengeni.databasePasswordFiles.env" -}}
{{- if include "opengeni.databasePasswordFiles.enabled" . }}
- name: OPENGENI_DATABASE_PASSWORD_FILE
  value: {{ printf "%s/password" (include "opengeni.databasePasswordFiles.mountPath" .) | quote }}
- name: OPENGENI_DATABASE_PREVIOUS_PASSWORD_FILE
  value: {{ printf "%s/previous-password" (include "opengeni.databasePasswordFiles.mountPath" .) | quote }}
{{- end }}
{{- end -}}

{{- define "opengeni.databasePasswordFiles.volumeMount" -}}
{{- if include "opengeni.databasePasswordFiles.enabled" . }}
- name: runtime-database-password
  mountPath: {{ include "opengeni.databasePasswordFiles.mountPath" . }}
  readOnly: true
{{- end }}
{{- end -}}

{{- define "opengeni.databasePasswordFiles.volume" -}}
{{- if include "opengeni.databasePasswordFiles.enabled" . }}
- name: runtime-database-password
  secret:
    secretName: {{ default (include "opengeni.secretName" .) .Values.runtimeDatabasePasswordFiles.secretName | quote }}
    # optional: the pod starts, and each listed key that is missing is simply
    # absent from the directory, until the rotation adds the keys.
    optional: true
    defaultMode: 0444
    items:
      - key: OPENGENI_DATABASE_PASSWORD
        path: password
      - key: OPENGENI_DATABASE_PREVIOUS_PASSWORD
        path: previous-password
{{- end }}
{{- end -}}
