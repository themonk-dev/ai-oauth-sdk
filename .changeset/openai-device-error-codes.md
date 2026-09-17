---
'@ai-oauth-sdk/core': patch
---

Stop a failed OpenAI device-flow poll from quoting your device codes into the error message

`openaiDeviceFlow.poll()` quoted the provider's response body when the poll failed with
anything other than the "not approved yet" 403/404. For this flow that body routinely names
the two values we just posted, `device_auth_id` and `user_code` — and unlike an RFC 8628
device code, that pair is the whole approval credential: posting it back to the poll endpoint
returns an authorization code *and* the PKCE verifier OpenAI generated for it, so anyone who
reads the pair out of a log can finish the sign-in with nothing else but the published client
id. Neither name was in the redaction list, and `code` could not reach inside `user_code`.

Both codes are now scrubbed out of the snippet by value before it is quoted, which covers the
provider's own prose ("device authorization da_01J… for user_code WXYZ-1234 is in an invalid
state") as well as a gateway reflecting the request back — prose has no `key: value` shape for
name-based redaction to find. `device_auth_id` and `user_code` were also added to
`redactSecrets()`, so they are scrubbed anywhere else a response body is quoted.

Error messages keep their diagnostic value: the status, and everything in the body that is not
one of your own codes, are unchanged.
