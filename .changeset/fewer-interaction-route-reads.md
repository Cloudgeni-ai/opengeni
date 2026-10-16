---
"@opengeni/api-router": patch
---

Browser and computer actions on a Connected Machine make fewer database round trips before reaching the controller. The source session is read alongside its authorization check (a denial still wins), the machine route check reuses the live-attempt reads that authorization just made instead of repeating them, and computer actions reuse the machine connection the request already resolved instead of looking it up again. Everything from the controller call onward still reads fresh.
