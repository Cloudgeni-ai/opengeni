{{/* Bounded source/evaluation age, independent of the producer's clock. */}}
{{- define "opengeni.workerScaler.fresh" -}}
(
  {{ .series }}
  and (time() - timestamp({{ .series }}) < {{ .age | default 60 }})
  and (time() - timestamp({{ .series }}) >= -5)
  {{- if eq (int (.age | default 60)) 30 }}
  # Inter-rule path: every dependency must be from THIS sequential group
  # evaluation, not merely within lookback after one stage failed/stalled.
  and (timestamp({{ .series }}) == time())
  {{- end }}
)
{{- end -}}

{{/* Carry ORIGINAL expiry, never time()+TTL from a recorded intermediate.
All four app clocks share the raw cohort labels. The fifth uses discovery up,
joined back onto that same cohort so the minimum keeps the complete identity. */}}
{{- define "opengeni.workerScaler.deadline" -}}
min without (deadline_source) (
  {{- range $index, $series := list .value .valid .observed }}
  {{ if $index }}or{{ end }} label_replace(timestamp({{ $series }}) + 60, "deadline_source", "sample{{ $index }}", "__name__", ".*")
  {{- end }}
  or label_replace({{ .observed }} + 60, "deadline_source", "producer", "__name__", ".*")
  or label_replace(
    0 * {{ .value }} + on (namespace, pod, pod_uid, job, instance) group_left ()
      (max by (namespace, pod, pod_uid, job, instance) (timestamp({{ .up }})) + 60),
    "deadline_source", "scrape", "__name__", ".*"
  )
)
{{- end -}}

{{/* Schema v1 is a narrowly supported policy, not arbitrary metric approval. */}}
{{- define "opengeni.workerScaler.validate" -}}
{{- $a := .Values.worker.turns.autoscaling -}}
{{- if and $a.enabled (gt (int $a.minReplicas) (int $a.maxReplicas)) -}}
{{- fail "turns autoscaling requires minReplicas <= maxReplicas" -}}
{{- end -}}
{{- if $a.queueDemand.enabled -}}
{{- if not (and .Values.worker.enabled $a.enabled .Values.observability.metrics.enabled .Values.observability.serviceMonitor.enabled) -}}
{{- fail "queueDemand requires worker, turns autoscaling, metrics and ServiceMonitor enabled" -}}
{{- end -}}
{{- if not (.Capabilities.APIVersions.Has "monitoring.coreos.com/v1") -}}
{{- fail "queueDemand requires monitoring.coreos.com/v1 (Prometheus Operator)" -}}
{{- end -}}
{{- if $a.slotSaturationMetric.enabled -}}
{{- fail "queueDemand schema v1 does not support slotSaturationMetric" -}}
{{- end -}}
{{- $legacyAgent := list (dict "type" "Pods" "pods" (dict "metric" (dict "name" "opengeni_turns_inflight") "target" (dict "type" "AverageValue" "averageValue" "8"))) -}}
{{- if and (not (empty $a.customMetrics)) (ne (toJson $a.customMetrics) (toJson $legacyAgent)) -}}
{{- fail "queueDemand schema v1 supports only empty customMetrics or the exact legacy agent inflight8 metric" -}}
{{- end -}}
{{- end -}}
{{- end -}}
