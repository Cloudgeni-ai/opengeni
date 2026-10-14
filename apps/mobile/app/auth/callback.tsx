import { Redirect } from "expo-router";

/**
 * `opengeni://auth/callback` is the sign-in browser's return address. The
 * sign-in flow reads the code from the browser result; on Android the system
 * also delivers the link to the router, which simply returns home.
 */
export default function AuthCallback() {
  return <Redirect href="/" />;
}
