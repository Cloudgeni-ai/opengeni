import { customType } from "drizzle-orm/pg-core";
import {
  fromPostgresLosslessJson,
  fromPostgresLosslessText,
  toPostgresLosslessJson,
  toPostgresLosslessText,
} from "./lossless-json";

export const losslessJsonb = customType<{ data: unknown; driverData: string }>({
  dataType() {
    return "jsonb";
  },
  toDriver(value) {
    return JSON.stringify(toPostgresLosslessJson(value));
  },
  fromDriver(value) {
    return fromPostgresLosslessJson(typeof value === "string" ? JSON.parse(value) : value);
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
    return fromPostgresLosslessText(value);
  },
});
