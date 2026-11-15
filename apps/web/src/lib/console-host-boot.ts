// Must evaluate before ./App creates the router from the current URL.
import { consoleHostRedirectPath } from "./console-route";

if (typeof window !== "undefined") {
  const target = consoleHostRedirectPath(
    window.location.hostname,
    window.location.pathname,
    window.location.search,
  );
  if (target) {
    window.history.replaceState(window.history.state, "", `${target}${window.location.hash}`);
  }
}
