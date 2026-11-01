---
"@opengeni/react": patch
---

A meeting's sticky player and "Ask about this meeting" bars now reach the window's edge when the host page pads its scroll frame. A sticky bar stops at its scroller's padding, so a host that keeps room at the bottom for its own floating button showed the meeting notes scrolling past under the Ask bar, and a host with top padding showed them above the pinned player. The page background now covers that strip: always under the Ask bar, which ends its column, and above the player while it is pinned. The cover is a clipped shadow, so it adds no scroll length and catches no clicks. Without host padding nothing changes. `demo/embedded-meeting.html` shows a meeting page in such a host.
