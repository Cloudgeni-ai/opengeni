// Ambient declarations for optional, untyped peer dependencies that are only
// ever reached via a lazy dynamic import inside a client-side effect. The
// concrete shape is narrowed at the call site with an explicit cast, so a bare
// module declaration is enough to keep `tsc` happy without pulling DOM-only
// libs into the type graph.

declare module "@novnc/novnc";
