import { readIosAppContext } from "./ios-app-context";

export const iosAppContext = typeof window !== "undefined" && readIosAppContext(window);
