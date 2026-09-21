---
'@ai-oauth-sdk/core': patch
---

Redact `device_auth_id` and `authorization_code`, the two credential names OpenAI's device flow uses.

`redactSecrets()` already covered `device_code` and `code`, which are what RFC 8628 and RFC 6749 call these values. OpenAI's device flow is not RFC 8628 and spells both differently: the device code arrives and is posted back as `device_auth_id`, and the approval response returns the authorization code under `authorization_code`. Neither name was on the list, so neither was scrubbed.

That mattered because `openaiDeviceFlow()` quotes the provider's response body in its errors. Both failure paths — the initial user-code request and the approval poll — put a `safeSnippet` of the body into the `OAuthError` message, and an error message ends up in logs, crash reporters and terminal scrollback. A gateway echoing the request back, which is the case `redactSecrets()` exists for, would have printed a live device credential there. This is an omission rather than a judgement call: the RFC-named equivalent of each was already listed.

`grant_type=authorization_code` is unaffected. The pattern matches a name in key position followed by `:` or `=`, so the grant type — where `authorization_code` is a value, and a public constant at that — still appears in full, and the diagnostic value of the message with it.
