---
"@opengeni/react-native": patch
---

The native chat shows the animated thinking orb again while a reply is being prepared, next to the status text, as the web chat does. It had been replaced by a small spinner. The orb still disappears on the first useful output, the status stays stable and says when a start takes longer than usual, a failed preparation stays visible, and a host's `renderPreparing` still replaces the default visual.
