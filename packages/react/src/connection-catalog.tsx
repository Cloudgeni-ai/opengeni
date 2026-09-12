import type { ReactNode } from "react";

/** Status comes from the host/controller, never inferred from a display label. */
export type ConnectionCatalogOption = {
  id: string;
  name: string;
  description?: string | undefined;
  status: string;
  connected: boolean;
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
  /** Group capabilities by service, or show every capability independently. */
  grouped?: boolean;
  className?: string;
  emptyMessage?: string;
};

function ConnectionDetailsIndicator() {
  return (
    <span aria-hidden className="og-connection-group-chevron">
      ›
    </span>
  );
}

export function ConnectionOptionRow({ option }: { option: ConnectionCatalogOption }) {
  return (
    <div className="og-connection-catalog-action-row og-connection-option">
      <button type="button" className="og-connection-catalog-row" onClick={option.onOpen}>
        <span className="og-connection-catalog-copy">
          <strong>{option.name}</strong>
          <span>{option.description}</span>
        </span>
        <span className="og-connection-catalog-status">{option.status}</span>
        {!option.action ? <ConnectionDetailsIndicator /> : null}
      </button>
      {option.action ? <span className="og-connection-option-action">{option.action}</span> : null}
    </div>
  );
}

export function ConnectionServiceRow({ service }: { service: ConnectionCatalogService }) {
  if (!service.options.length) return null;
  const connected = service.options.filter((option) => option.connected).length;
  const identity = (
    <>
      <span className="og-connection-catalog-logo">{service.logo}</span>
      <span className="og-connection-catalog-copy">
        <strong>{service.name}</strong>
        <span>
          {service.options.length === 1
            ? service.options[0]?.description
            : service.options.map((option) => option.name).join(" · ")}
        </span>
      </span>
      <span className="og-connection-catalog-status">
        {service.options.length === 1
          ? service.options[0]?.status
          : `${connected} of ${service.options.length} connected`}
      </span>
    </>
  );
  return service.options.length === 1 ? (
    <div className="og-connection-catalog-action-row">
      <button
        type="button"
        className="og-connection-catalog-row"
        onClick={service.options[0]!.onOpen}
      >
        {identity}
        {!service.options[0]?.action ? <ConnectionDetailsIndicator /> : null}
      </button>
      {service.options[0]?.action}
    </div>
  ) : (
    <details className="og-connection-catalog-service">
      <summary className="og-connection-catalog-row">
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
    <div className={`og-connection-catalog ${className}`} data-columns={columns}>
      {visible.length ? (
        visible.map((service) => <ConnectionServiceRow key={service.id} service={service} />)
      ) : (
        <p role="status">{emptyMessage}</p>
      )}
    </div>
  );
}
