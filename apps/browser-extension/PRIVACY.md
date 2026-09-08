# OpenGeni Browser privacy notice

Effective September 7, 2026. Published by Cloudgeni AS.

OpenGeni Browser connects a Chrome profile to the OpenGeni machine agent on
your computer. That agent connects to the OpenGeni deployment you configure.
This notice describes the extension; your deployment operator and configured
model providers also govern the information they receive.

## Information handled

The extension stores a generated device identifier, your optional profile label,
and a tab-inventory revision in Chrome local extension storage. It sends profile
and browser metadata, and open-tab titles, URLs, and state, to the local machine
agent when connected. It updates this inventory as tabs change.

When OpenGeni operates a tab, the extension can read page structure and content,
capture screenshots, perform navigation and input, and return browser events,
network information, and operation results. Depending on the sites and tasks,
this may include personal details, communications, financial or health
information, authentication information, and location information present in
pages or browser responses. Use a profile containing only information you intend
to make available to your OpenGeni deployment.

## Purpose and destinations

Information is used to identify the connected profile and perform browser tasks
through OpenGeni. The extension communicates through the local native messaging
host `ai.opengeni.browser`; it does not include an advertising or analytics SDK.
The machine agent can forward browser information to your configured OpenGeni
deployment. That deployment can process it using its configured model providers
and task tools, and retain it in session history, audit records, and artifacts.
Information therefore does not necessarily remain on your computer.

The extension itself does not sell information, use it for advertising, or
determine creditworthiness. Browser data is handled to provide its browser
automation functionality. The extension does not impose one retention period
across independently operated OpenGeni deployments.

## Controls and retention

Disable or uninstall the extension to stop its browser connection. Uninstalling
removes its local extension storage. Closing a tab or disconnecting a profile
does not erase information already sent to a deployment or its providers.
Contact your deployment operator for access, deletion, retention, and provider
details. Chrome displays a debugger notification when the extension attaches
to a tab. Chrome-restricted pages cannot be controlled.

## Contact

For extension privacy questions: jorgen@cloudgeni.ai.
Cloudgeni AS, Falkeveien 2A, 1476 Rasta, Norway.
