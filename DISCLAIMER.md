# Disclaimer

**`ai-oauth-sdk` is an independent, unofficial project.** It is not affiliated with,
authorized by, endorsed by, sponsored by, or in any way officially connected to OpenAI,
Anthropic, Google, GitHub, Microsoft, xAI, Alibaba, OpenRouter, or any other provider it
can talk to.

## No official support for these flows

None of these vendors publishes a supported, documented OAuth integration for
third-party clients. What this library encodes was **observed from the vendors' own
publicly distributed command-line tools** — Codex, Claude Code, Gemini CLI, the Copilot
CLI, grok-cli, qwen-code — and from the standards those tools implement (RFC 6749, RFC
7636, RFC 8252, RFC 8628, OpenID Connect Discovery).

That has two consequences you should plan around:

- **Nothing here is stable by contract.** Endpoints, scopes, client ids and response
  shapes can change or stop working at any time, without notice and without it being a
  bug in this library.
- **No vendor owes you support for it.** Do not open a ticket with a provider about
  behaviour caused by this library.

## Trademarks

ChatGPT, Codex and OpenAI are trademarks of OpenAI. Claude and Anthropic are trademarks
of Anthropic. Gemini and Google are trademarks of Google LLC. GitHub and Copilot are
trademarks of Microsoft Corporation. Grok and xAI are trademarks of xAI. Qwen is a
trademark of Alibaba Group. All other marks belong to their respective owners.

These names are used **solely to identify which service a given configuration talks
to** — nominative fair use. Their appearance here does not imply any endorsement or
association.

## Client identifiers

The values in `publicClientIds` are public OAuth client identifiers, extracted from
software the vendors distribute. OAuth is designed so that publishing a public client id
is safe, and they are not secrets.

They are still *someone else's* identifiers. **Using one means presenting your
application as that vendor's CLI.** That is why no provider defaults to one and you must
name it explicitly. Before shipping it in anything, read the provider's terms of service
and developer policy, and register your own client wherever one is on offer.

No client **secret** is bundled for any provider. Where one is required — Google — you
register your own client and supply it.

## Your responsibility

You are responsible for how you use this software, including compliance with each
provider's terms of service, acceptable use policy, and applicable law. Whether a
particular use is permitted is a question for the provider's terms and, if it matters to
you, your own legal advice — not for this README.

Authenticate only with accounts you own or are authorized to use.

## Warranty

This project is released under the [MIT License](LICENSE) and is provided **"as is",
without warranty of any kind**, express or implied. See the LICENSE file for the full
disclaimer of warranty and limitation of liability, which govern.

## Requests from rights holders

If you represent a provider and want your service's configuration changed or removed,
please open an issue or use [private vulnerability
reporting](https://github.com/themonk-dev/ai-oauth-sdk/security/advisories/new). We will
act on it promptly.
