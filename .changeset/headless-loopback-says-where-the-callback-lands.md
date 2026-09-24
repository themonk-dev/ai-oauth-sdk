---
'@ai-oauth-sdk/node': patch
---

Say what the headless fall-through in `defaultReceiver()` is actually doing, so an SSH login that cannot complete fails visibly instead of hanging in silence.

`defaultReceiver()` detects a headless machine — no display, or `SSH_TTY`/`SSH_CONNECTION` set — and steers away from loopback. But steering away needs somewhere to steer *to*, and the only alternative it has is `promptReceiver()`, which it can only pick for a provider that publishes a hosted redirect page. Among the bundled providers that is Claude and nobody else. OpenAI, Gemini, xAI, OpenRouter and Azure AI all fall through to a loopback server bound on the remote box, while the provider redirects the browser on the user's laptop to the laptop's own `localhost:1455`, where nothing is listening. `client.login()` arms a deadline only when `timeoutMs` is passed and there is no default, so `await login('openai')` over SSH waits forever, having printed a URL and nothing else.

The receiver choice is unchanged. Switching the fall-through to `hybridReceiver` is the obvious fix and is not made here: `promptReceiver` reads stdin, which would break daemons and CI jobs that currently get a printed URL and no prompt, and the CLI branches on `receiver.id === 'loopback'`. That is a behaviour change on a public API and belongs to whoever owns the API, not to a bug fix.

What changes is the message. It now states that the callback is being served from *this* host, that on approval the provider redirects to this machine's `localhost` — which over SSH is the laptop's, not the server's — and names the three ways out: forward the port, `--paste` to hand the redirected URL back yourself, or `deviceLogin()`/`--device` where the provider has a device flow. It also says that no deadline is armed unless `timeoutMs` (`--timeout`) is passed. The hang is still there; it is now one the user can read and act on.

The troubleshooting docs claimed `defaultReceiver()` "switches automatically, so this usually means a receiver was chosen explicitly", which was true only for Claude and sent everyone else looking in the wrong place. Corrected to describe what happens.
