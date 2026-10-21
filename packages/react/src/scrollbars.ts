// Classic-scrollbar detection without the rest of the package, so an app can
// mark its document before the first paint from its eager entry chunk.
export { CLASSIC_SCROLLBARS_ATTRIBUTE, markClassicScrollbars } from "./lib/scrollbars";
