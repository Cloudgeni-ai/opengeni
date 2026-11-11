/**
 * Shared item-type rules for provider adapters.
 *
 * A provider without a native slot for an Opengeni type or category (for
 * example Bitwarden has no API-key item and no categories) keeps them in one
 * reserved text field, `opengeni.type`, whose value is the type and, when the
 * item has one, its category: "api_key" or "api_key/database". Adapters write
 * it only when the provider's own type does not already say it, and hide it
 * on read, so the item reads back exactly as written and nothing is lost when
 * it moves between providers. People see it in the provider's app as an
 * ordinary custom field; removing it there only drops the type to the
 * provider's own.
 */
import {
  VaultItemCategory,
  VaultItemType,
  standardVaultFieldName,
  type VaultItemType as ItemType,
} from "@opengeni/contracts";

export const VAULT_TYPE_MARKER_FIELD = "opengeni.type";

export interface ItemTypeMarker {
  type: ItemType;
  category: string | null;
}

export function encodeItemTypeMarker(marker: ItemTypeMarker): string {
  return marker.category ? `${marker.type}/${marker.category}` : marker.type;
}

/** The type and category a marker value names, or null when it names none. */
export function decodeItemTypeMarker(value: string | null | undefined): ItemTypeMarker | null {
  if (!value) return null;
  const [type, category, ...rest] = value.trim().split("/");
  if (rest.length > 0) return null;
  const parsedType = VaultItemType.safeParse(type);
  if (!parsedType.success || parsedType.data === "passkey") return null;
  if (category === undefined) return { type: parsedType.data, category: null };
  const parsedCategory = VaultItemCategory.safeParse(category);
  return parsedCategory.success ? { type: parsedType.data, category: parsedCategory.data } : null;
}

export function isItemTypeMarkerName(name: string): boolean {
  return name.normalize("NFC").trim().toLowerCase() === VAULT_TYPE_MARKER_FIELD;
}

/** A card expiry written as one value: "MM/YYYY", "MM/YY", "YYYY-MM" or "YYYYMM". */
export function parseCardExpiry(value: string): { month: string; year: string } | null {
  const text = value.trim();
  let month: string | undefined;
  let year: string | undefined;
  let match = /^(\d{1,2})\s*[/.-]\s*(\d{2}|\d{4})$/.exec(text);
  if (match) [, month, year] = match;
  match = match ?? /^(\d{4})\s*[/.-]?\s*(\d{2})$/.exec(text);
  if (match && !month) [, year, month] = match;
  if (!month || !year) return null;
  const monthNumber = Number(month);
  if (monthNumber < 1 || monthNumber > 12) return null;
  return { month: String(monthNumber), year: year.length === 2 ? `20${year}` : year };
}

/**
 * Which standard field a write targets: the Opengeni name of the slot (see
 * `VAULT_ITEM_TYPE_FIELDS`), or null when it stays a custom field.
 */
export function standardFieldFor(type: ItemType, name: string): string | null {
  return standardVaultFieldName(type, name);
}
