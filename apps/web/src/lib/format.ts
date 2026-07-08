// Shared formatting helpers for the console.
import type { EntitlementValue, Entitlements } from "@/types";

export function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
}

export function localDateTimeValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function displayModel(value: string): string {
  return value.startsWith("gpt-") ? value.replace("gpt-", "").toUpperCase() : value;
}

export function formatMoneyMicros(amountMicros: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amountMicros / 1_000_000);
}

export function validTopupAmount(value: string): boolean {
  const amount = Number(value);
  return (
    Number.isFinite(amount) &&
    amount >= 5 &&
    amount <= 10_000 &&
    Math.abs(amount - Math.round(amount * 100) / 100) < 1e-9
  );
}

/** Human label for an entitlement value (`true` reads as "enabled", not "true"). */
export function formatEntitlementValue(value: EntitlementValue): string {
  if (typeof value === "boolean") {
    return value ? "enabled" : "disabled";
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "none";
  }
  return String(value);
}

/** Stable, render-ready rows for the account's entitlements map. */
export function entitlementEntries(
  entitlements: Entitlements,
): Array<{ name: string; value: string }> {
  return Object.entries(entitlements)
    .map(([name, value]) => ({ name, value: formatEntitlementValue(value) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function repoCountLabel(count: number): string {
  return `${count} ${count === 1 ? "repo" : "repos"}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === "GB") {
      return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
    }
    value /= 1024;
  }
  return `${bytes} B`;
}

/** Compact elapsed-time label, e.g. "4s", "2m 13s", "1h 04m". */
export function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}
