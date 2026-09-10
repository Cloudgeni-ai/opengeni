# Product shapes and UI

## Choose the smallest suitable surface

OpenGeni supports several product shapes. Select from the product experience and host stack rather than assuming every integration needs a custom chat:

| Need | Likely surface | Product owns |
| --- | --- | --- |
| The complete OpenGeni experience is acceptable | Link or deep-link to stock OpenGeni | Entry point and product navigation |
| Custom UI in any framework, mobile app, CLI, or automation | OpenGeni SDK or public API behind product backend | All user-facing presentation |
| React product wants canonical session state without packaged visuals | Headless React session hooks and projections | Components, layout, and styling |
| React product wants packaged chat/session controls | Focused styled React subpaths | Shell, domain UI, and theming |
| Product exposes files, changes, terminal, or desktop compute | Optional workbench surfaces | Product shell and selected tabs |

Start with the narrowest surface that preserves the desired experience. Do not mount the full workbench for an ordinary analytics chat. Do not rebuild session streaming, replay, queueing, approval, or timeline projection when a compatible package already supplies the needed behavior.

## Evaluate reuse before writing chat UI

For React hosts, inspect the installed OpenGeni React package before creating replacement components. Its subpaths are composable, and the styled surfaces use scoped compiled CSS plus runtime theme and density tokens. Compare:

- packaged components with customer theme tokens;
- headless hooks with customer-native components; and
- a fully custom SDK-driven UI.

Choose based on UX requirements and dependency compatibility, then record why. Styling differences alone are not a reason to skip reusable components if their structure fits. Conversely, do not force a packaged component when the product needs a materially different interaction model.

For Svelte, SvelteKit, Vue, native mobile, or another non-React frontend, use the product's native component system. Keep the privileged OpenGeni client on a compatible backend boundary. A SvelteKit server route may use the TypeScript SDK directly; a non-JavaScript backend may use the public HTTP contract or a small compatible adapter. The browser still speaks to authenticated product routes.

## Browser/backend split

The product browser normally sends product-shaped requests to its own same-origin backend. The backend authenticates, resolves the allowed mapping, and calls OpenGeni. Never bundle an organization key into frontend code.

For live sessions, preserve event sequence, reconnect, replay, and duplicate suppression. The SDK's stream and proxy helpers are preferred where compatible. Treat unknown additive event types as forward-compatible data rather than crashing the UI.

Uploads may send bytes directly to a short-lived signed storage URL returned by the trusted flow. That URL is narrow transfer authority, not the OpenGeni API key. Verify storage CORS for every intended browser origin.

## Decide what the user sees

OpenGeni's durable event stream can support different product projections:

- final answer only;
- assistant messages plus progress and status;
- selected tool-call summaries;
- approvals and structured human-input cards; or
- a detailed operational timeline.

The customer frontend chooses which event types and fields to render. Hiding an event from the chat view does not remove it from OpenGeni's durable history or from authorized audit readers. Do not promise data erasure or secrecy from presentation filtering.

Even a final-answer-only UI should surface states the user must act on: failure, cancellation, credit or policy denial, approval requests, human-input requests, reconnect status, and a way to retry safely. Avoid presenting tool failures as ordinary assistant prose when product state can represent them more clearly.

## Fit the host product

Follow existing navigation, accessibility, responsive, loading, error, observability, localization, and design-system conventions. Keep OpenGeni IDs behind product-native identifiers. Make the smallest dependency addition that improves correctness.

The integration should feel native to the customer product while retaining OpenGeni's session semantics. Framework adaptation is expected; protocol reimplementation is not a goal.
