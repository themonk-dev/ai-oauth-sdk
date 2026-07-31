---
'@ai-oauth-sdk/node': minor
'@ai-oauth-sdk/cli': patch
'@ai-oauth-sdk/core': patch
---

Make every flow either work or say why it cannot.

**Anthropic no longer makes you paste.** It defaulted to `hosted` redirect mode,
so the only route was copying a code out of the browser — while Claude Code
itself runs a local server and catches the callback. It now defaults to
`loopback` on an ephemeral port and sends `code=true`, matching the official
client. The hosted page stays declared, and `defaultReceiver` routes any
provider that has one to the paste prompt once there is no local browser —
otherwise a remote box's `localhost` URI reaches a browser that cannot answer
it, and Anthropic has no device flow to fall back on.

**`--paste` no longer strands a local browser.** For a provider with no hosted
page — OpenAI, Google — the redirect went to a loopback port nothing was
listening on, so the browser showed "This site can't be reached" and the code
was only readable out of the address bar. We already know the port, so
`hybridReceiver` binds it and races the two: the server finishes the login when
the browser is on this machine, the paste prompt when it is not. On a laptop
nothing is copied at all; over SSH it behaves as before.

Three things keep that race honest:

- **The listener is best-effort.** Binding fails when the port is held or the
  sandbox forbids `listen()` — precisely the conditions `--paste` exists to
  serve — so a failure falls back to the prompt rather than ending the login
  before the URL is printed.
- **Only the prompt's *success* competes.** A blank line or a mistyped paste
  rejects that half; letting a rejection win would tear down a server about to
  receive a perfectly good callback, burning the authorization code.
- **Only the prompt announces.** Presenting both halves opened the authorize URL
  two or three times, since the loopback receiver honours a caller-supplied
  `openUrl` regardless of its own `openBrowser: false`.

`manualReceiver` prefers a declared `hostedUri` over synthesising a loopback
URI, and `promptReceiver` accepts a `signal` so a pending stdin read can be
abandoned when something else completes the flow.

**Unknown options are now errors.** `--loopback` parsed, was ignored, and the
command ran its default — so it looked like a mode selector that did nothing:

```
✗ Unknown option "--loopback".
  loopback is the default — drop the flag, or use --paste / --device
```

Single-dash long options are caught too. `-device` was exploded into six
one-character keys, every one skipped by the guard, so the typo silently ran a
browser login and then waited on a headless box for a callback that could never
arrive. Clusters still expand when every character is a real short flag.

**`--paste` on a device-only provider now fails.** The guard existed but sat
inside receiver selection, which the device-only branch short-circuits past — so
`login github-copilot --paste` quietly ran a device login instead.

**Google's device flow is gone.** The endpoint exists but accepts only a client
registered as "TVs and Limited Input devices", and a coding CLI is not a
television; the published gemini-cli client is a Desktop app, refused with
`invalid_client / Invalid client type`. Providers can still carry a
`devicePrerequisite`, surfaced when the request fails rather than only alongside
a code that never arrives.
