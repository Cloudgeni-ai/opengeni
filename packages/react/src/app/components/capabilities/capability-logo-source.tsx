import type { CapabilityCatalogItem } from "../../types";
import { capabilityLogoFallback } from "../../../connect";

/**
 * First-party connector rows are synthesized by the API rather than imported
 * from integrations.sh, so they cannot carry an object-storage logo path.
 * Their small reviewed mark set (apps/web/public/capability-logos, with its
 * manifest) ships inside the package as data URLs, so every host shows them
 * without serving the files itself. A test keeps these identical to the
 * committed files.
 */
export const FIRST_PARTY_CAPABILITY_LOGOS: Readonly<Record<string, string>> = {
  "api:excel-addin":
    "data:image/svg+xml,%3Csvg%20role%3D%22img%22%20viewBox%3D%220%200%2024%2024%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%0A%20%20%3Ctitle%3EMicrosoft%20Excel%3C%2Ftitle%3E%0A%20%20%3Crect%20width%3D%2224%22%20height%3D%2224%22%20rx%3D%225%22%20fill%3D%22%23107c41%22%2F%3E%0A%20%20%3Cpath%20d%3D%22M7%206.5h2.4l2.6%203.9%202.6-3.9H17l-3.8%205.5L17%2017.5h-2.4L12%2013.6l-2.6%203.9H7l3.8-5.5z%22%20fill%3D%22%23fff%22%2F%3E%0A%3C%2Fsvg%3E%0A",
  "api:fiken":
    "data:image/svg+xml,%3Csvg%20role%3D%22img%22%20viewBox%3D%220%200%20192%20192%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%0A%20%20%3Ctitle%3EFiken%3C%2Ftitle%3E%0A%20%20%3Crect%20width%3D%22192%22%20height%3D%22192%22%20rx%3D%2236%22%20fill%3D%22%23fff%22%2F%3E%0A%20%20%3Cpath%20d%3D%22M88%20157V83c0-27%2018-47%2042-47%208%200%2015%202%2022%206%22%20fill%3D%22none%22%20stroke%3D%22%2375a7f5%22%20stroke-linecap%3D%22round%22%20stroke-width%3D%2225%22%2F%3E%0A%20%20%3Cpath%20d%3D%22M46%20114h84M88%2082v75%22%20fill%3D%22none%22%20stroke%3D%22%235838c6%22%20stroke-linecap%3D%22round%22%20stroke-width%3D%2225%22%2F%3E%0A%3C%2Fsvg%3E%0A",
  "api:github-app":
    "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20role%3D%22img%22%20aria-label%3D%22GitHub%22%3E%0A%20%20%3Crect%20width%3D%2224%22%20height%3D%2224%22%20rx%3D%225%22%20fill%3D%22%23fff%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2324292f%22%20d%3D%22M%2012%20.7a11.5%2011.5%200%200%200-3.6%2022.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7%201.2.1%201.8%201.2%201.8%201.2%201.1%201.8%202.8%201.3%203.5%201%20.1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.7%200-1.3.5-2.3%201.2-3.1-.1-.3-.5-1.5.1-3.1%200%200%201-.3%203.2%201.2a11%2011%200%200%201%205.8%200C17%204.8%2018%205.1%2018%205.1c.6%201.6.2%202.8.1%203.1.8.8%201.2%201.9%201.2%203.1%200%204.4-2.8%205.4-5.5%205.7.4.4.8%201.1.8%202.2v3.3c0%20.3.2.7.8.6A11.5%2011.5%200%200%200%2012%20.7Z%22%2F%3E%0A%3C%2Fsvg%3E",
  "api:reddit":
    "data:image/svg+xml,%3Csvg%20role%3D%22img%22%20viewBox%3D%220%200%2024%2024%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%0A%20%20%3Ctitle%3EReddit%3C%2Ftitle%3E%0A%20%20%3Cpath%20fill%3D%22%23ff4500%22%20d%3D%22M%2012%200C5.373%200%200%205.373%200%2012c0%203.314%201.343%206.314%203.515%208.485l-2.286%202.286C.775%2023.225%201.097%2024%201.738%2024H12c6.627%200%2012-5.373%2012-12S18.627%200%2012%200Zm4.388%203.199c1.104%200%201.999.895%201.999%201.999%200%201.105-.895%202-1.999%202-.946%200-1.739-.657-1.947-1.539v.002c-1.147.162-2.032%201.15-2.032%202.341v.007c1.776.067%203.4.567%204.686%201.363.473-.363%201.064-.58%201.707-.58%201.547%200%202.802%201.254%202.802%202.802%200%201.117-.655%202.081-1.601%202.531-.088%203.256-3.637%205.876-7.997%205.876-4.361%200-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538%200-1.548%201.255-2.802%202.803-2.802.645%200%201.239.218%201.712.585%201.275-.79%202.881-1.291%204.64-1.365v-.01c0-1.663%201.263-3.034%202.88-3.207.188-.911.993-1.595%201.959-1.595Zm-8.085%208.376c-.784%200-1.459.78-1.506%201.797-.047%201.016.64%201.429%201.426%201.429.786%200%201.371-.369%201.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406%200c-.786%200-1.385.824-1.338%201.841.047%201.017.634%201.385%201.418%201.385.785%200%201.473-.413%201.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703%204.013c-.974%200-1.907.048-2.77.135-.147.015-.241.168-.183.305.483%201.154%201.622%201.964%202.953%201.964%201.33%200%202.47-.81%202.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z%22%2F%3E%0A%3C%2Fsvg%3E%0A",
  "api:x":
    "data:image/svg+xml,%3Csvg%20role%3D%22img%22%20viewBox%3D%220%200%2024%2024%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%0A%20%20%3Ctitle%3EX%3C%2Ftitle%3E%0A%20%20%3Crect%20width%3D%2224%22%20height%3D%2224%22%20rx%3D%224%22%20fill%3D%22%23fff%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%23000%22%20d%3D%22M14.234%2010.162%2022.977%200h-2.072l-7.591%208.824L7.251%200H.258l9.168%2013.343L.258%2024H2.33l8.016-9.318L16.749%2024h6.993zm-2.837%203.299-.929-1.329L3.076%201.56h3.182l5.965%208.532.929%201.329%207.754%2011.09h-3.182z%22%2F%3E%0A%3C%2Fsvg%3E%0A",
};

export function capabilityLogoSource(
  item: Pick<CapabilityCatalogItem, "id" | "logoAssetPath"> &
    Partial<Pick<CapabilityCatalogItem, "metadata">>,
  catalogAssetUrl: (path: string | null) => string | null,
): string | null {
  const localLogo = FIRST_PARTY_CAPABILITY_LOGOS[item.id] ?? catalogAssetUrl(item.logoAssetPath);
  if (localLogo) return localLogo;

  // Imports retain the upstream URL after applying our curated overrides,
  // including explicit nulls that suppress a provider's logo.
  return capabilityLogoFallback(item);
}
