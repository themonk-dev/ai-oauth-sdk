---
'@ai-oauth-sdk/core': patch
---

Decide between a callback's query and its fragment on the part before the `#`.

`parseStandardCallback()` accepts a full redirect URL, a bare query string or a `#`-prefixed fragment, because providers disagree about where they put the response. Choosing between the query and the fragment was done by testing the remainder for `code=` — but that remainder still had the fragment on it, so the test was reading a string that included the thing it was choosing against. Three separate failures came out of that one line:

- `?code=A&state=B#frag` kept the query, which is right, and left the fragment attached to it, so `state` parsed as `B#frag` and failed the comparison against the state that was presented.
- `?error=access_denied&state=S#z` contains no `code=` anywhere, so the query was discarded in favour of a fragment holding nothing and the whole parse came back `{}`. A denial vanished, and the login hung instead of reporting why it failed.
- `?state=S#code=A` matched `code=` in the *fragment* while the test was meant to be about the query, so the query won and the code was never found.

All three fail closed — a state mismatch, a hung login, a useless error — so this is robustness rather than a hole. The rule is now explicit: if the part before the `#` carries a `code` or `error` parameter it is the response and the fragment is dropped; otherwise the fragment is the response. The pattern anchors on `^` or `&`, so `error_description=` and `authorization_code=` cannot pass for the parameter itself.

A provider that answers wholly in the fragment — `https://app/cb#code=X&state=Y` — has neither parameter before the `#`, so it takes the fragment. That case now works where it did not. The old test was guarded on the input containing a `?`, so a full redirect URL carrying only a fragment response never reached it: the entire URL was handed to the query parser, no `code` was found, and `readCallback()` threw `no code returned`. Only the bare `#code=X&state=Y` form parsed, through a separate branch. An app that passes `window.location.href` rather than `window.location.search` against a fragment-mode provider — a `promptReceiver` paste, or a `popupReceiver` fed the full URL — is the case this fixes.
