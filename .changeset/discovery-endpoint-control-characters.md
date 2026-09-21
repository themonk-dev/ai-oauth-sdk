---
'@ai-oauth-sdk/core': patch
'@ai-oauth-sdk/node': patch
---

Refuse a control character in a discovered endpoint, store the endpoint the URL parser actually validated, and stop routing the Windows browser launch through `cmd.exe`.

`providerFromDiscovery()` checked `authorization_endpoint` by parsing it and reading `.protocol`, then threw the parse away and stored the document's raw string. Those are not the same value. The WHATWG URL parser strips tab, carriage return and line feed wherever they appear — as a silent repair, not a rejection — so `https://evil.test/a\r\ncalc.exe\r\n` parses with a `protocol` of `https:` and passed every check, while what went into `provider.authorizationUrl` still had the line break in it. `appendQuery()` copies everything before the `?` verbatim, so the descriptor carried it on intact.

On Windows that string reached a shell. `start` is a `cmd.exe` builtin, so the launcher spawned `cmd /c start "" <url>` and `cmd` re-read the command line the child-process layer had built. A carriage return there ends one command and begins the next.

Both halves are closed, and both were worth closing separately.

A value taken from a discovery document must now contain no C0 control character and no DEL, checked before the parse rather than after it, and the endpoint stored is the parser's own `href`. A value that passes only because the parser rewrote it is refused rather than repaired: a document naming an endpoint with a line break in it is not one whose author's intent can be guessed at. The refusal is its own error, distinct from the existing "not a valid URL" one, because such a URL does parse and saying otherwise would send whoever reads the message looking for the wrong thing. It covers `authorization_endpoint`, `token_endpoint` and `device_authorization_endpoint`, and the issuer itself; an endpoint you passed explicitly is still your own config and is neither checked nor normalised.

The launcher change is not specific to discovered URLs and does not depend on that check. `escapeForCmd` prefixed `&|^<>()` with `^`, which handled the metacharacter every authorization URL is full of, and it could never have handled `%`: `^` does not escape it and nothing on a `cmd` command line does, so `https://evil.test/?x=%USERPROFILE%` had the variable expanded before the browser saw it and sent the user's home path to whoever served the URL. That gap was documented as deliberate. It is not escapable, so the escaping is gone along with the shell: Windows now launches with `rundll32 url.dll,FileProtocolHandler <url>`, Microsoft's documented mechanism, which takes the URL as an argument and re-parses nothing. `escapeForCmd` was never exported from the package and has been removed. macOS and Linux are untouched, as is `AI_OAUTH_SDK_NO_BROWSER`.

As belt-and-braces for every URL source, `openBrowser()` now declines to spawn anything at all when the URL contains a control character, on any platform. The caller already falls back to printing the URL, so a login still completes.
