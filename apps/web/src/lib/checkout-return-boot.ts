// Must evaluate before ./console-host-boot and ./App rewrite the address: a
// checkout return (credits or a plan) is confirmed once the app is ready,
// even when a host redirect or an unfinished setup step drops its keys first.
import { rememberCheckoutPageReturn } from "@opengeni/react/app/lib/credit-checkout";

if (typeof window !== "undefined") rememberCheckoutPageReturn(window.location.search);
