import { customType, integer } from "drizzle-orm/pg-core";
import { toPostgresLosslessJson, toPostgresLosslessText } from "./lossless-json";

/**
 * Codec truth is explicit and out-of-band. This column intentionally has no
 * database or application default: a caller may set version 1 only in the same
 * statement that writes the corresponding value through the lossless codec.
 */
export function losslessCodecVersion<TName extends string>(name: TName) {
  return integer(name);
}

export const losslessJsonb = customType<{ data: unknown; driverData: string }>({
  dataType() {
    return "jsonb";
  },
  toDriver(value) {
    return JSON.stringify(toPostgresLosslessJson(value));
  },
  fromDriver(value) {
    return typeof value === "string" ? JSON.parse(value) : value;
  },
});

export const losslessText = customType<{ data: string; driverData: string }>({
  dataType() {
    return "text";
  },
  toDriver(value) {
    return toPostgresLosslessText(value);
  },
  fromDriver(value) {
    return value;
  },
});
