// @opengeni/react/machines — Bring-your-own-compute: Machines dashboard +
// enrollment flow + status surfacing (M9). View-model types mirror the M10
// contract shape (MachineView / MetricSample / MachinesResponse) — see
// types/machines.ts.
//
// This is a self-contained island carved out of the package root so consumers
// that don't surface connected machines never pull it in. The root still
// re-exports everything here for backwards compatibility (deprecated).
export type {
  ConnectionStatus,
  MachineKind,
  MachineMetricsSeriesResponse,
  MachineState,
  MachineView,
  MachinesResponse,
  MetricSample,
} from "./types/machines";
export { connectionStatusForState } from "./types/machines";
export {
  ConnectionDot,
  ConnectionStatusPill,
  MachineStatusPill,
  CONNECTION_STATUS_META,
  MACHINE_STATE_BADGE_META,
} from "./components/machine-status-pill";
export type {
  ConnectionDotProps,
  ConnectionStatusMeta,
  ConnectionStatusPillProps,
  MachineStateBadgeMeta,
  MachineStatusPillProps,
} from "./components/machine-status-pill";
export { MachineMetrics } from "./components/machine-metrics";
export type { MachineMetricsProps } from "./components/machine-metrics";
export { MachineCard } from "./components/machine-card";
export type { MachineCardProps } from "./components/machine-card";
export { MachineHealthPill } from "./components/machine-health-pill";
export type { MachineHealthPillProps } from "./components/machine-health-pill";
// Telemetry: fused health signal + history charts + the per-machine detail view.
export { deriveHealth, HEALTH_TOKEN, healthPulses } from "./components/machines/health";
export type { HealthLevel, HealthVerdict } from "./components/machines/health";
export { MetricSparkline } from "./components/machines/metric-sparkline";
export type { MetricSparklineProps } from "./components/machines/metric-sparkline";
export { MetricHistoryChart } from "./components/machines/metric-history-chart";
export type {
  MetricHistoryChartProps,
  SeriesPoint,
} from "./components/machines/metric-history-chart";
export { MachineDetail } from "./components/machines/machine-detail";
export type { MachineDetailProps } from "./components/machines/machine-detail";
export { METRICS, METRIC_WINDOWS, WINDOW_LABEL, pointsFor } from "./components/machines/series";
export type { MetricDef, MetricKey, MetricWindow } from "./components/machines/series";
export { MachinesDashboard } from "./components/machines-dashboard";
export type { MachinesDashboardProps } from "./components/machines-dashboard";
export { MachineDockBar, SharedMachineDisclosure } from "./components/machine-dock-bar";
export type {
  MachineDockBarProps,
  SharedMachineDisclosureProps,
} from "./components/machine-dock-bar";
export { EnrollmentDeviceFlow } from "./components/enrollment-device-flow";
export type {
  DeviceFlowPhase,
  EnrollmentDeviceFlowProps,
} from "./components/enrollment-device-flow";
export { EnrollmentConsent } from "./components/enrollment-consent";
export type {
  EnrollmentConsentMachine,
  EnrollmentConsentPhase,
  EnrollmentConsentProps,
} from "./components/enrollment-consent";
export { useMachines } from "./hooks/use-machines";
export type {
  MachinesClientLike,
  UseMachinesOptions,
  UseMachinesResult,
} from "./hooks/use-machines";
