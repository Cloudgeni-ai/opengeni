---
"@opengeni/runtime": patch
---

A missing BrowserSession or ComputerSession is now recognised from the API's own refusal rather than the error's display text. Before, browser_open naming a missing linked computer could add a second, wrong BrowserSession hint when a listed computer's name contained text like ": BrowserSession not found".
