# Voice on a ChatGPT subscription

Sign in with ChatGPT from the page, then hold an always-on GPT Live voice call over WebRTC. No API
key anywhere: the subscription token opens the call through a private `codex app-server`.

```bash
pnpm install              # from the repo root; brings in @openai/codex for this example
pnpm build                # the page loads the workspace build of ai-oauth-sdk.global.js
node examples/voice-chatgpt/server.js
# open http://localhost:3100
```

1. **Sign in with ChatGPT.** The SDK's OpenAI device flow runs in the browser (auth.openai.com allows
   CORS), the token lands in `sessionStorage`. Same model as chat.themonk.dev.
2. **Start voice.** The page creates a WebRTC offer and posts it with its bearer token to
   `/api/voice/start`. The server spawns `codex app-server` in a private `CODEX_HOME` holding that
   token, asks it for the call, and returns the SDP answer. Audio then flows browser ↔ OpenAI.
3. Ask *"what time is it?"* to watch a native handoff: GPT Live delegates to the execution agent,
   which calls the server-owned `get_local_time` tool and speaks the result.

## Files

| File | Role |
| --- | --- |
| `index.html` | Page: `AIOAuth.createAuthClient(...).deviceLogin()`, then plain `RTCPeerConnection`. |
| `server.js` | Static page, the SDK bundle, and three routes: start, NDJSON events, delete. |
| `voice-bridge.js` | JSON-RPC to `codex app-server`: initialize → thread/start → thread/realtime/start. |

## Notes

- Needs a plan with ChatGPT Voice (Plus, Pro, Business, Edu, Enterprise). Voice has its own rolling
  five-hour allowance; delegated tool turns spend Codex quota.
- The browser keeps the refresh token; the server only ever sees the access token for the duration
  of a call, so a call cannot outlive that token (days, in practice). A `refreshTokens` hook exists
  on `CodexVoiceSession` for servers that do hold one.
- This is OpenAI's private ChatGPT/Codex transport, not the public Realtime API.
