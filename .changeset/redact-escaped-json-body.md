---
'@ai-oauth-sdk/core': patch
---

Redact credentials in a response body that arrives escaped, or with the value written as an array.

`redactSecrets()` matched a key, an optional quote, `:` or `=`, an optional quote and then the value. That shape assumed the body it was handed was the document the provider wrote. Very often it is not: the interesting failure — the one the redaction exists for, and the one its own comment names — is a gateway echoing the request it proxied, and a gateway that does so in JSON embeds that copy in a string of its own. What actually reaches the pattern is then `{"upstream":"received {\"refresh_token\":\"rt-…\"}"}`. The optional quote could not match the backslash, so `[:=]` landed on it, the match failed, and nothing was redacted.

The value that survived is a live refresh token, and where it survived to is the message of the thrown `OAuthError` — built by `safeSnippet()` from the response body — which goes on to the consumer's logs, crash reporter and terminal scrollback. The paths affected are the ones that scrub the body as raw text: the non-JSON branch, and the fallback the JSON branch takes when the body carries no `error` or `error_description` to quote instead. A value reached through `error_description` itself was already scrubbed, because `JSON.parse` has resolved one level of escaping by the time it is read.

The same root cause produced a second miss with no escaping involved. A value written as a one-element array, `{"refresh_token":["rt-…"]}`, put a `[` where the pattern expected the value to begin; `[` is not one of the value terminators, so it was taken as the first character and the quote immediately behind it ended the value one character in, below the four-character floor that keeps `code=ok` out of the redaction. Nothing matched, and the token went out whole.

Each optional quote may now be preceded by a backslash, and the value may open with a `[`. The value's own character class is unchanged, deliberately: it is the only thing stopping a match running past its terminator, and admitting a backslash to it would swallow the closing `\"` and redact the rest of the diagnostic along with the secret.

Two limits are deliberate. Only one level of escaping is handled — that is what a reflecting gateway produces, and each further level is a strictly less likely arrangement for a strictly wider pattern. And a *second* element in an array value is still not matched: it carries no key of its own to anchor on, and reaching it would mean matching bare quoted strings anywhere in the body, which is the over-reach the whole pattern is shaped to avoid.

No parameter names were added. This remains what the file has always said it is: recognition of the OAuth parameter names and the token shapes the supported providers issue, and not a guarantee that an arbitrary secret is safe to print.
