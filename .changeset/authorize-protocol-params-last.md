---
'@ai-oauth-sdk/core': patch
---

Write the protocol parameters after `extraParams` in `buildAuthorizationUrl`, so a caller cannot replace them.

`response_type`, `client_id`, `redirect_uri` and `state` were assigned before `...provider.extraAuthParams, ...input.extraParams`, so a caller-supplied map could overwrite any of them. `scope` and the PKCE pair were already safe, but only incidentally — they happen to be assigned after the spread. All six now are.

This is defence in depth, and the changelog should not pretend otherwise: nothing here was exploitable. The flow already fails shut end to end. The pending record keeps the `state` this SDK minted, so `login()`'s constant-time comparison rejects a substituted one as `state_mismatch` and the manual path finds no matching record and throws `unknown_state`; the code exchange replays `pending.redirectUri` regardless of what went out on the authorize URL. What changes is that the guarantee is now structural and readable at the point the URL is built, instead of being reconstructed from three checks in other files.

`provider.buildAuthParams` still has the last word, unchanged. That is descriptor configuration written alongside the endpoints it belongs to, not caller input. The JSDoc on `extraParams` now says which parameters cannot be overridden.

One consequence worth stating rather than burying, since it cuts against that rationale: `provider.extraAuthParams` moves behind the protocol parameters too, so a *descriptor* can no longer set `response_type` (or `client_id`, `redirect_uri`, `state`) that way either. No bundled provider does — OpenRouter is the only one that reshapes the parameter set and it uses `buildAuthParams`, which still runs last — so nothing shipped changes behaviour. A custom descriptor relying on `extraAuthParams: { response_type: … }` would now silently lose that override and should move it to `buildAuthParams`.
