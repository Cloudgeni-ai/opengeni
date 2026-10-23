/** Reviewed packaging replacement for operator cloud-auth.ts, not a live edit. */
import { CloudFailure, WatchdogCloud } from "./watchdog-cloud";
export const project = "cloudgeni-gecko",
  region = "europe-west1";
const cloud = new WatchdogCloud();
export class GcpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
  ) {
    super(`GCP ${method} failed ${status}; body suppressed`);
  }
}
export const identityToken = (audience: string) => cloud.identityToken(audience);
export async function api(
  url: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<any> {
  if (new URL(url).protocol !== "https:" || !new URL(url).hostname.endsWith(".googleapis.com"))
    throw Error("Operator Google API endpoint required");
  try {
    const response = await cloud.request(url, {
      method,
      headers: { "Content-Type": "application/json", "x-goog-user-project": project },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new GcpError(response.status, method);
    return response.status === 204 ? {} : response.json();
  } catch (error) {
    if (error instanceof CloudFailure) throw new GcpError(error.status, method);
    throw error;
  }
}
