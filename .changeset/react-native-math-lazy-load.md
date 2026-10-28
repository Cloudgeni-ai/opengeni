---
"@opengeni/react-native": patch
---

Opening a chat no longer loads MathJax up front. The built timeline imported it as the module loaded, which crashed release builds whose global `document` is partial; MathJax now loads only when a message first shows math.
