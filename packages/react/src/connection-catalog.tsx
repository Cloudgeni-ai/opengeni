import type { ReactNode } from "react";
import {
  CapabilityCatalogIndicator,
  CapabilityCatalogRow,
  type CapabilityCatalogStatus,
} from "./capability-catalog-row";

/** Status comes from the host/controller, never inferred from a display label. */
export type ConnectionCatalogOption = {
  id: string;
  name: string;
  description?: string | undefined;
  status: string;
  connected: boolean;
  /** Explicit health/availability. Omit to retain visible legacy status text. */
  state?: CapabilityCatalogStatus;
  onOpen: () => void;
  action?: ReactNode;
};
export type ConnectionCatalogService = {
  id: string;
  name: string;
  logo?: ReactNode;
  options: ConnectionCatalogOption[];
};
export type ConnectionCatalogProps = {
  services: ConnectionCatalogService[];
  query?: string;
  columns?: 1 | 2;
  resultLimit?: number;
  onShowMore?: () => void;
  /** Group capabilities by service, or show every capability independently. */
  grouped?: boolean;
  className?: string;
  emptyMessage?: string;
};

export function ConnectionOptionRow({ option }: { option: ConnectionCatalogOption }) {
  return (
    <div className="og-connection-catalog-action-row og-connection-option">
      <CapabilityCatalogRow
        name={option.name}
        description={option.description}
        status={option.state ?? (option.connected ? "added" : "available")}
        statusLabel={option.status}
        showStatusLabel={option.state === undefined}
        onOpen={option.onOpen}
      />
      {option.action ? <span className="og-connection-option-action">{option.action}</span> : null}
    </div>
  );
}

export function ConnectionServiceRow({ service }: { service: ConnectionCatalogService }) {
  if (!service.options.length) return null;
  const connected = service.options.filter((option) => option.connected).length;
  const attention = service.options.find(
    (option) => option.state === "attention" || option.state === "unavailable",
  );
  const groupState =
    attention?.state ??
    (service.options.some((option) => option.state === "loading")
      ? "loading"
      : connected === service.options.length
        ? "added"
        : "available");
  const identity = (
    <>
      <span className="og-capability-catalog-icon">{service.logo}</span>
      <span className="og-capability-catalog-copy">
        <strong>{service.name}</strong>
        <span>
          {service.options.length === 1
            ? service.options[0]?.description
            : service.options.map((option) => option.name).join(" · ")}
        </span>
      </span>
      <CapabilityCatalogIndicator
        status={groupState}
        label={attention?.status ?? `${connected} of ${service.options.length} added`}
      />
    </>
  );
  return service.options.length === 1 ? (
    <div className="og-connection-catalog-action-row">
      <CapabilityCatalogRow
        name={service.name}
        description={service.options[0]!.description}
        icon={service.logo}
        status={service.options[0]!.state ?? (connected ? "added" : "available")}
        statusLabel={service.options[0]!.status}
        showStatusLabel={service.options[0]!.state === undefined}
        onOpen={service.options[0]!.onOpen}
      />
      {service.options[0]?.action}
    </div>
  ) : (
    <details className="og-connection-catalog-service">
      <summary className="og-capability-catalog-row">
        {identity}
        <span aria-hidden className="og-connection-group-chevron">
          ⌄
        </span>
      </summary>
      <div className="og-connection-catalog-options">
        {service.options.map((option) => (
          <ConnectionOptionRow key={option.id} option={option} />
        ))}
      </div>
    </details>
  );
}

export function ConnectionCatalog({
  services,
  query = "",
  columns = 1,
  grouped = true,
  resultLimit,
  onShowMore,
  className = "",
  emptyMessage = "No connections match your search.",
}: ConnectionCatalogProps) {
  const search = query.trim().toLowerCase();
  const entries = grouped
    ? services
    : services.flatMap((service) =>
        service.options.map((option) => ({
          ...service,
          id: `${service.id}/${option.id}`,
          name:
            service.options.length > 1 && option.name !== service.name
              ? `${service.name} · ${option.name}`
              : service.name,
          options: [option],
        })),
      );
  const visible = entries.filter((service) =>
    [service.name, ...service.options.flatMap((option) => [option.name, option.description ?? ""])]
      .join(" ")
      .toLowerCase()
      .includes(search),
  );
  return (
    <>
      <div className={`og-connection-catalog ${className}`} data-columns={columns}>
        {visible.length ? (
          visible
            .slice(0, resultLimit)
            .map((service) => <ConnectionServiceRow key={service.id} service={service} />)
        ) : (
          <p role="status">{emptyMessage}</p>
        )}
      </div>
      {resultLimit && visible.length > resultLimit ? (
        <button className="og-catalog-more" type="button" onClick={onShowMore}>
          View all connections
        </button>
      ) : null}
    </>
  );
}
