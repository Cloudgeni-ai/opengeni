---
"@opengeni/browserd": patch
---

On macOS, the first computer-use reading of a Chrome window now includes the page. Chrome accepts the driver's accessibility switch but reports an error, so the driver used to skip waiting for the page and kept re-sending the switch, which stopped Chrome from ever building the page tree while reads came quickly. A dropdown menu that is really open is also closed at once instead of after a wait Chrome ignores.
