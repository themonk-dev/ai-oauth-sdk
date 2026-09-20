---
'@ai-oauth-sdk/core': patch
---

Stop a discovery document overriding a `deviceAuthorizationUrl` you passed yourself.

`providerFromDiscovery()` takes `authorizationUrl` and `tokenUrl` from the document only when you
did not supply them, which is what SECURITY.md promises — "endpoints you pass explicitly are your
own config and are left alone". `device_authorization_endpoint` worked the other way round: the
document won unconditionally, so an integrator who pinned the device endpoint as hardening had it
silently replaced by whatever the document named. That is the one endpoint whose response puts a
`verification_uri` in front of the user to open and type a code into, so it is the least
comfortable one to hand back to a remote party.

An explicitly passed `deviceAuthorizationUrl` is now kept, and the document's value is taken only
in its absence — the same `== null` test as the two endpoints above it, so a `null` from a JS
caller or an unset key in a JSON config still falls through to the document and is still checked.

The https check on the document's value moved behind the same condition. Validating a value you
have deliberately ignored would have failed your login over a document that is none of your
business; a document endpoint that is actually going to be used is checked exactly as before.
