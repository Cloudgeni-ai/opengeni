{{/* Kubernetes termination grace for turn pods. */}}
{{- define "opengeni.turnWorkerTerminationGracePeriodSeconds" -}}
{{- $value := .Values.worker.turns.terminationGracePeriodSeconds -}}
{{- if kindIs "invalid" $value -}}
{{- $value = .Values.worker.terminationGracePeriodSeconds -}}
{{- end -}}
{{- int $value -}}
{{- end -}}

{{/*
Turn-worker graceful shutdown env. A draining turn worker stops polling, lets
in-flight turns finish naturally for the grace, cancels the rest with
WORKER_SHUTDOWN (recoverable checkpoint), force-stops at the force time and
exits at most 10 seconds later. Unset values derive from the pod grace with 15
seconds between phases (90 s / 105 s at 120 s). A variable set in `config` is
owned there and not rendered. Explicit values that would let the kubelet kill
the process before the force time, or leave no checkpoint window, fail.
*/}}
{{- define "opengeni.turnWorkerShutdownEnv" -}}
{{- $shutdown := .Values.worker.turns.shutdown | default dict -}}
{{- $podGrace := int (include "opengeni.turnWorkerTerminationGracePeriodSeconds" .) -}}
{{- $config := .Values.config | default dict -}}
{{- $force := 0 -}}
{{- if kindIs "invalid" $shutdown.forceSeconds -}}
{{- $force = min 3600 (max 10 (sub $podGrace 15)) -}}
{{- else -}}
{{- if not (and (or (kindIs "float64" $shutdown.forceSeconds) (kindIs "int" $shutdown.forceSeconds) (kindIs "int64" $shutdown.forceSeconds)) (eq (float64 $shutdown.forceSeconds) (float64 (int $shutdown.forceSeconds)))) -}}
{{- fail "worker.turns.shutdown.forceSeconds must be a whole number of seconds or null" -}}
{{- end -}}
{{- $force = int $shutdown.forceSeconds -}}
{{- if lt $force 10 -}}
{{- fail "worker.turns.shutdown.forceSeconds must be at least 10" -}}
{{- end -}}
{{- if ge (add $force 10) $podGrace -}}
{{- fail (printf "worker.turns.shutdown.forceSeconds (%d) plus the 10-second process exit margin must stay below the turn pod terminationGracePeriodSeconds (%d)" $force $podGrace) -}}
{{- end -}}
{{- end -}}
{{- $grace := 0 -}}
{{- if kindIs "invalid" $shutdown.graceSeconds -}}
{{- $grace = max 0 (sub $force 15) -}}
{{- else -}}
{{- if not (and (or (kindIs "float64" $shutdown.graceSeconds) (kindIs "int" $shutdown.graceSeconds) (kindIs "int64" $shutdown.graceSeconds)) (eq (float64 $shutdown.graceSeconds) (float64 (int $shutdown.graceSeconds)))) -}}
{{- fail "worker.turns.shutdown.graceSeconds must be a whole number of seconds or null" -}}
{{- end -}}
{{- $grace = int $shutdown.graceSeconds -}}
{{- if lt $grace 0 -}}
{{- fail "worker.turns.shutdown.graceSeconds must not be negative" -}}
{{- end -}}
{{- if gt (add $grace 10) $force -}}
{{- fail (printf "worker.turns.shutdown.graceSeconds (%d) must end at least 10 seconds before forceSeconds (%d) so cancelled turns can checkpoint" $grace $force) -}}
{{- end -}}
{{- end -}}
{{- if or (gt $force 3600) (gt $grace 3600) (ge (add $force 10) $podGrace) (gt (add $grace 10) $force) -}}
{{- fail "resolved turn shutdown sequence must fit application limits (3600 seconds) and leave a checkpoint window and force + 10 seconds strictly below pod grace" -}}
{{- end }}
{{- if not (hasKey $config "OPENGENI_TURN_WORKER_SHUTDOWN_GRACE_MS") }}
- name: OPENGENI_TURN_WORKER_SHUTDOWN_GRACE_MS
  value: {{ mul $grace 1000 | quote }}
{{- end }}
{{- if not (hasKey $config "OPENGENI_TURN_WORKER_SHUTDOWN_FORCE_MS") }}
- name: OPENGENI_TURN_WORKER_SHUTDOWN_FORCE_MS
  value: {{ mul $force 1000 | quote }}
{{- end }}
{{- end -}}
