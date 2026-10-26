---
"@opengeni/config": minor
---

New chats and scheduled tasks that start on Opengeni credits now default to medium reasoning instead of extra high (`OPENGENI_CREDITS_DEFAULT_REASONING_EFFORT`, still clamped to the model). Most first chats are everyday questions, and medium is the model's own default, so answers come faster and use fewer credits. A deployment that wants the previous behaviour sets `OPENGENI_CREDITS_DEFAULT_REASONING_EFFORT=xhigh`; saved workspace and organization defaults and explicit choices are unchanged.
