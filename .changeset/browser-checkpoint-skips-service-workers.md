---
"@opengeni/browserd": patch
---

Pausing a managed browser no longer saves the sites' installed service workers and their Cache Storage copies of site assets. Web apps such as cloud consoles keep hundreds of MB there, which made a checkpoint many times larger than the sign-ins and site storage it is for, so pausing and resuming over a slow connection took minutes. Cookies, local storage and IndexedDB are still saved; a site installs its service worker again on the next visit.
