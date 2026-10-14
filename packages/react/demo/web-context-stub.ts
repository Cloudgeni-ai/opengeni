// Demo-only stand-in for the web app's context: the permission board passes its
// own synthetic client, so no session, auth or network is involved.
let client: unknown = null;
export function setDemoClient(value: unknown) {
  client = value;
}
export function useAppContext() {
  return { client };
}
