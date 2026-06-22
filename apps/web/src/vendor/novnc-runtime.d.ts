// @novnc/novnc ships no types and is only reached via a lazy dynamic import
// inside @opengeni/react's desktop-stream effect (the shape is cast at the call
// site). A bare module declaration keeps `tsc` happy across the workspace.
declare module "@novnc/novnc";
