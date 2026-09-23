# Browser authorization handoff

Browser hosts can use `createBrowserConnectNavigation(window)` with the helper
below. Importing the package does not access `window`. Popup mode opens a fresh
blank window, clears its opener before provider navigation, and retains a close
handle. If isolation fails, it closes the blank window and reports a generic
error; a blocked popup does not silently redirect. Full redirect remains an
explicit host choice. Browser security policies may sever the popup handle;
completion is still obtained from the backend, never from that handle.

`authorizeConnectAttempt(transport, attempt, navigation, options)` accepts an
injected `ConnectNavigation` adapter and either `popup` or `redirect` mode.
Call popup mode directly from a user gesture: opening is synchronous, a blocked
popup throws explicitly, and only backend polling determines the result. The
popup is closed when polling settles. Cancellation stops polling, not the
durable server attempt; cancel that explicitly through the controller if desired.

For redirect mode, retain the opaque attempt ID in host-owned state before
calling the helper. It passes the authorization URL unchanged and returns `null`;
recover the attempt and poll after returning. No completion query parameters or
window messages are required or trusted. Authorization destinations must use
HTTPS without embedded credentials. Provider adapters run on the server;
optional setup and account presentation lives in `@opengeni/react/connect`.

# @opengeni/connect

Framework-neutral state for a durable OpenGeni connection setup attempt. This
package contains no React, browser storage, provider SDK, or server credentials.
Use `ConnectController` with an authenticated `ConnectTransport`; use
`@opengeni/react/connect` to observe that same controller from React.

The controller forwards the exact return URL, models credentials committed
separately from integration installed, preserves revision/idempotency fences,
and rejects responses for another workspace or attempt. Popup messages and
navigation are not proof of completion: recover or refresh the durable attempt
through the transport. List pending attempts through `transport.pending` when
the opener or browser state is lost.

Controller snapshots retain only a fixed generic transport-failure message, not
raw error messages, causes or request objects that could contain credentials.
Method rejections still reach the direct caller unchanged; hosts must redact
those errors before logging or displaying them. Backend attempt projections
must likewise remain credential-free.

Create one controller for the selected workspace and dispose it when the host
replaces that workspace or its authenticated user. Observer unmount is not
controller disposal. Secret form values go only to `advance`; snapshots never
retain submitted values. The transport must sanitize server error responses.

The implementation branch now has durable curated OAuth begin/read endpoints
and SDK `beginConnect`, `getConnectAttempt`, and `listPendingConnectAttempts`.
Use these on the trusted host backend through an `asUser` client. Retain the
attempt ID before navigation. The callback returns to the exact stored host URL
without appended parameters; querying the attempt distinguishes committed
credentials from finished integration installation. Repeated callbacks replay a
receipt without repeating the provider token exchange.

Curated attempts also support SDK `advanceConnectAttempt` and
`cancelConnectAttempt`. Advance with `retry` to obtain a preview after OAuth;
then install with its revision/content hash and explicitly selected operation
IDs. Changed source returns a fresh preview for review. Cancellation stops setup
without revoking credentials already saved. The unstyled setup form exposes
these review/install controls and labels each operation's risk category.

On the trusted host backend, `client.asUser(externalId).connectTransport()`
supplies the complete transport interface using the client's fixed actor,
contract checks, error handling and abort signal support. Never send that
organization-key client to the browser. A browser transport must call the host's
authenticated backend, which derives the actor from its own session and checks
workspace access; browser-supplied actor IDs are not proof of identity.

Catalog readiness reflects curated provider configuration and current access.
Accounts expose connection metadata, not credentials. `disconnect` uses the
existing local connection-revocation endpoint: it removes OpenGeni access, not
upstream provider consent. Aborting an in-flight mutation stops observation and
does not guarantee that the server rolled it back; recover durable attempts
before deciding whether to retry. A signal already aborted before dispatch
prevents the SDK request from being sent.

The server catalog reports provider readiness and ownership requirements. Native
setup and embedding products share the controller and React setup surface.
Reconnect uses an observed account/version; provider-specific installation and
resource selection remain explicit next actions. Controller tests alone do not
prove backend authorization or vendor OAuth conformance.

Model-account device flows retain their existing pool APIs and can share
`pollDeviceAuthorization` and the optional React `DeviceAuthorization` surface.

`findConnectRecoveryAccount(accounts, connectionId)` resolves timeline auth-needed
events to the exact fresh account, including social-domain IDs. It never guesses
by provider or label. Missing accounts need explicit user selection; host-managed
credentials recover through the product's own account flow.

`@opengeni/react/connect` also exports `ConnectSetup`, an unstyled setup form.
Pass the controller and an `onAuthorize(attempt)` callback (called directly from
the click handler, so it can open a popup). It labels ownership, requires explicit
account selection, clears credential inputs before awaiting submission, and
never preselects installation operations. `onBrowseResources` lets the host own
paginated selections; the built-in form refuses to submit an incomplete page.
`ConnectChooser` from the same React export supplies an optional unstyled
provider/ownership form. Pass `controller` and the exact `returnUrl`; it uses
`transport.catalog` readiness, disables unavailable providers and requires an
explicit ownership choice. Replace the controller on actor/workspace changes;
stale catalog responses are discarded. Hosts still provide navigation, account
management and pending-attempt recovery. Backend readiness and authorization
remain mandatory; browser-disabled options are not an access-control boundary.

`controller.waitForAction({ timeoutMs })` polls the selected attempt and publishes
the resulting action or terminal state to subscribers (also exposed by
`useConnect`). It rejects revisions older than the selected snapshot, never
retries mutations, and stops when the controller is disposed or another attempt
is selected. A timeout stops observation, not the durable server operation.