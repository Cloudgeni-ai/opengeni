# OpenGeni web UI

Before adding a control, search `src/components/ui`, `src/components/pickers.tsx`, and the chat
composer for an existing workspace-wide pattern. Reuse or extend the shared component instead of
building a route-specific lookalike.

## Product UI rules

- Keep the primary task visible and progressively disclose secondary configuration. Do not put
  bordered cards inside bordered cards or give every setting equal visual weight.
- Use plain outcome-based copy. Labels should describe what the user is choosing (for example,
  “Start a new chat”), not internal persistence terms such as session reuse or target session.
- Any model choice must show its payment source—OpenGeni credits, Codex subscription, SuperGrok
  subscription, or the workspace AI Gateway—and use the shared model-policy picker.
- Reuse shared disclosure, picker, menu, field, switch, button, and status primitives. If a pattern
  will plausibly appear on another workspace route, extract it before shipping the second version.
- Prefer one clean vertical form. Use horizontal layout only for a compact label/action row or a
  tightly related choice group.
- Preserve keyboard access, focus treatment, coarse-pointer targets, loading/error states, and
  truthful unavailable states when simplifying a control.
- For visible UI changes, run the relevant tests and typecheck, then inspect the live local route at
  desktop width before handing it off.
