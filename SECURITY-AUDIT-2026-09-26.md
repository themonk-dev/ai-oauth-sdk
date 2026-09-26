# Daily security audit — 2026-09-26

## Headline

**The detection half of this routine is working. The delivery half has stalled, and the
routine is now working against itself.**

There are **19 open pull requests** from previous runs of this routine, the oldest from
**2026-08-19** — five weeks of daily output, none merged, none reviewed. `main` has not
received a single one of these fixes.

That changes what today's run is worth. A full sweep of the surface those PRs have *not*
touched produced **zero confirmed new vulnerabilities** — five of its eleven candidates were
already fixed in the backlog, and the two strongest of the rest died on adversarial review.
The bottleneck is not finding vulnerabilities; it is that nothing lands. And because every run starts fresh from `main` with no knowledge of
the open PRs, the routine has spent those five weeks **re-discovering and re-fixing the
same bugs**, producing pull requests that now conflict with each other.

---

## Finding 1 — The backlog no longer applies to itself (major, process)

Each PR is individually clean against `main`. Landed in sequence, they are not.

Simulated merge of all 19 in chronological order:

| Result | Count | PRs |
|---|---|---|
| Merged cleanly | 10 | #38, #40, #41, #42, #46, #47, #48, #49, #53, #54 |
| **Conflicted** | **9** | #39, #43, #44, #45, #50, #55, #56, #57, #58 |

The damage is worst at the recent end — exactly the PRs carrying the most work:

- #55 — conflicts in 6 files
- #56 — conflicts in 7 files
- #57 — conflicts in 5 files
- #58 — conflicts in 3 files

This degrades every day the backlog sits. Two source files are modified by **8 of the 19
open PRs** each:

| File | Open PRs touching it |
|---|---|
| `packages/node/src/loopback.ts` | 8 |
| `packages/core/src/client.ts` | 8 |
| `packages/core/src/providers/index.ts` | 7 |
| `packages/core/src/store.ts` | 6 |
| `packages/core/src/redact.ts` | 6 |
| `packages/cli/src/commands.ts` | 6 |
| `packages/react-native/src/receivers.ts` | 5 |
| `packages/browser/src/popup.ts` | 5 |

## Finding 2 — Three PRs rewrite the same line, three incompatible ways (major, process)

The clearest proof that runs cannot see each other. `packages/core/src/providers/github-copilot.ts:149`
on `main` reads:

```ts
return typeof api === 'string' && api ? api : undefined
```

Three separate PRs replace that one line, and they **disagree on the security policy**:

| PR | Requires https | Loopback exempt? | On a bad value |
|---|---|---|---|
| #50 | yes | **yes** | return `undefined` (fall back) |
| #55 | yes | **yes** | **throw `OAuthError`** |
| #57 | yes | **no** | return `undefined` (fall back) |

Whoever merges one of these has to adjudicate two real design questions — is a loopback
Copilot API host acceptable, and should a bad value fail the sign-in or fall back — that
three different runs answered three different ways. Merging any one makes the other two
conflict.

## Finding 3 — ~70 fixes, but nowhere near 70 distinct bugs (major, process)

The 19 PRs carry **70 changeset entries**. Grouping them by underlying defect, roughly
**22 distinct vulnerabilities account for about 50 of those entries.** Each has been found
2–4 times on different days and fixed differently each time.

The worst repeats:

| Underlying defect | Re-fixed in |
|---|---|
| logout / in-flight refresh race | #39, #41, #47, #55 (4×) |
| SSR / worker storage guard | #39, #42, #55, #56 (4×) |
| Expo `authSessionReceiver` callback attribution | #38, #56, #58 (3×) |
| credential left under a previous provider id | #38, #39, #55 (3×) |
| device-flow poll leaking codes into errors | #39, #55, #57 (3×) |
| `useAuth` re-key on provider/storage change | #39, #53, #54 (3×) |
| Copilot `endpoints.api` https floor | #50, #55, #57 (3×) |
| refuse redirects on credential-bearing requests | #38, #56 (2×) |
| loopback crash on a malformed request target | #38, #56 (2×) |
| redact an escaped credential in a response body | #38, #50 (2×) |
| empty `AI_OAUTH_SDK_HOME` writing to cwd | #39, #55 (2×) |
| OpenAI device-flow timing bounds | #39, #55 (2×) |
| pinned `deviceAuthorizationUrl` vs discovery | #39, #56 (2×) |
| CLI single-character flag rejection | #44, #56 (2×) |
| CLI `Object.prototype` flag names | #44, #56 (2×) |
| control characters in a URL / endpoint | #43, #57 (2×) |
| serialise `consume()` across clients | #48, #55 (2×) |
| superseded login overwriting the newer login's state | #56, #58 (2×) |
| revocation reporting false success | #42, #44, #58 (3×) |
| loopback IPv6 `::1` crash | #55, #57 (2×) |
| `usePkce: undefined` / `defineProvider` defaults | #40, #55 (2×) |
| provider id aliasing another's storage key | #39, #46 (2×) |

## Today's detection sweep — and what it proves

The sweep deliberately targeted the surface the 19 open PRs have *not* touched
(`fetch.ts`, `http.ts`, `token.ts`, `query.ts`, `crypto/`, `registry.ts`, the concrete
provider descriptors, `receivers/manual.ts`, `receivers/device.ts`, `browser/storage.ts`,
`auto.ts`, `login.ts`, the solid/vue/svelte adapters, `cli/output.ts`).

It surfaced **11 substantive candidates. Five were already fixed in the unmerged backlog,
and the two strongest of the remainder were rejected on adversarial review.**
**Confirmed new vulnerabilities: zero.**

| # | Candidate | Verdict |
|---|---|---|
| 1 | `azureAi()` gives every Entra tenant the id `azure-ai`, so two directories share `tokens:azure-ai` | NEW, **reviewed → not a vulnerability** |
| 2 | `token.ts:119` dereferences a body of `null` → raw `TypeError`, escaping the `OAuthError` contract | NEW (minor, not reviewer-vetted) |
| 3 | `fetch.ts:387` `fetchUserInfo` casts unparsed JSON to `UserInfo`; HTML 200 → raw `SyntaxError` | NEW (minor, not reviewer-vetted) |
| 4 | device flow does not validate `verification_uri` *scheme* (`javascript:`, `file:`) | NEW, **reviewed → rejected**, low-priority hardening |
| 5 | browser SSR gate: a *throwing* storage getter lands in the Safari-private `catch` → module-scope `Map` | NEW (narrow, not reviewer-vetted) |
| 6 | `TOKEN_SHAPES` omits Google's `1//…` refresh shape vs SECURITY.md's promise | NEW (doc gap, not reviewer-vetted) |
| 7 | `base64UrlDecode`'s `/=+$/` backtracks quadratically — 117 KB `id_token` stalls the loop 11.5 s | **DUPLICATE — PR #44** |
| 8 | provider text reaches the terminal with ANSI escapes intact; a token endpoint can repaint `✗` as `✓` | **DUPLICATE — PR #44** |
| 9 | `table()` measures column widths on raw `String.length`, so escapes mis-pad every column | **DUPLICATE — PR #44** |
| 10 | browser SSR gate: globals *present* on a server runtime (Deno, Node `--experimental-webstorage`) | **DUPLICATE — PR #45** |
| 11 | `createBrowserAuthClient` spreads the storage default *before* caller options, so `{storage: undefined}` erases it | **DUPLICATE — PR #45** |

Candidates 7–11 are not near-misses; they are the same defects with the same fixes.
PR #44 adds precisely the linear reverse scan for #7, the `plain()` C0/C1/DEL stripper for
#8, and `safeRows` stripping cells *before* measuring for #9. PR #45 adds precisely
`inDocument()` for #10 and `options.storage ?? sessionStorageAdapter()` for #11.

**A process note against myself, because it is the same failure:** the exclusion briefing I
gave the hunters covered only the 8 most recent PRs, not all 19. That is exactly why they
re-derived #44's and #45's work. Two of the three hunters caught it independently by
diffing all 19 branches themselves. The lesson is not "the hunters erred" — it is that the
exclusion set must be the **whole open set**, and that a partial one reproduces the
routine's core defect inside a single run.

### Net result after adversarial review: no confirmed new vulnerability

Both candidates that went to the reviewer came back rejected **as vulnerabilities**. The
review corrected me as well as the hunter, so the correction is recorded here rather than
quietly dropped.

**`azureAi()` is tenant-scoped in its endpoints but not in its identity.**
`packages/core/src/providers/azure-ai.ts:41-42` folds `tenant` into every endpoint;
line 45 hardcodes `id: 'azure-ai'`. The credential key is derived from the id alone
(`client.ts:528`), so `azureAi({tenant:'contoso…'})` and `azureAi({tenant:'fabrikam…'})`
both read and write `tokens:azure-ai`. An app signing into two directories is served,
refreshes, and logs out of the wrong tenant's token, with no attacker involved.

`azure-ai.ts` is untouched by all 19 open PRs, and `providers.test.ts` cannot catch it: it
iterates `Object.values(providers)`, and `azureAi` is a factory that is not in that map.

**Verdict: a real foot-gun and a docs cross-reference gap. Not a vulnerability. No code
change.** Two things killed it, and I had the second one wrong myself:

1. **`accountKey` is the documented answer, and it is documented prominently.**
   `docs/content/reference/tokens.mdx:78-84` shows this exact two-client pattern with
   `accountKey: 'work'` / `'personal'`, and `docs/content/recipes/multi-user.mdx:7-27`
   prescribes `accountKey` *plus* `prefixedStorage`. My earlier claim that the docs never
   tell you to use it was **wrong**. The real gap is narrow: `azure-ai.mdx`'s "Multi-tenant"
   section explains what `tenant` values mean without cross-referencing either page, and it
   never actually recommends building two clients.
2. **`azure-ai.ts:42` hardcodes the host for every tenant.** Every tenant's token endpoint is
   `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`. So the cross-tenant
   callback case sends the code and PKCE verifier to a **different path on the same host,
   operated by the same issuer that minted the code** - Microsoft rejects a code presented
   to the wrong authority and the login simply fails. That is categorically not the OAuth
   BCP section 4.4 mix-up the `#ownsProviderId` comment describes, where the credential
   reaches a *different* issuer. Nothing crosses a trust boundary.

On the secondary claim the review also corrected my reasoning while reaching the same
conclusion. I said state secrecy made it unreachable; in fact the guard's whole scenario is
a mis-routed shared `/callback`, where the state arrives in the request URL, so it *is*
reachable - it just has no impact, per point 2. Note also that `accountKey` does **not**
isolate pending records (keyed `pending:<state>`, no account scoping); only `prefixedStorage`
does, which is why the multi-user recipe prescribes both.

**I am withdrawing the fix I sketched earlier in this run.** Scoping the id to the tenant is
not merely breaking, it is wrong: `#readRenamedTokens` (`client.ts:544-572`) *moves* a
`previousIds` record rather than copying it, so with a tenant-scoped id whichever tenant's
client reads first would claim the shared legacy `tokens:azure-ai` and the others would get
nothing - order-dependent and nondeterministic. It would also break the CLI's
`provider:`-keyed descriptor store.

The right change is two sentences in `azure-ai.mdx`'s Multi-tenant section: the provider id
is `azure-ai` for every tenant, so a client per tenant needs its own `accountKey`, plus
`prefixedStorage` if the store is shared; link `recipes/multi-user`.

## What to do

**Do not ask this routine for more detection until the backlog drains.** More PRs make the
conflict problem worse, not better.

1. **Land the 10 that still merge cleanly**, in this order:
   **#38, #40, #41, #42, #46, #47, #48, #49, #53, #54.**

   This is not a guess — I built that exact stack in a scratch worktree and ran the
   repo's own checks against it:

   | Check | Result |
   |---|---|
   | 10 sequential merges | all clean, no conflicts |
   | `vitest run` | **42 files, 703 passed, 5 skipped** (`main` baseline: 37 files, 611 passed) |
   | `eslint .` | clean, exit 0 |
   | `tsc --noEmit` (core) | clean, exit 0 |

   So landing those ten is a green, lint-clean, type-clean tree that adds ~92 regression
   tests over today's `main`. It can go in as-is.
2. **Then rebase the remaining 9** onto the new `main`. Most of their conflicts are with
   *duplicate fixes of their own findings* that will already be on `main` by then, so a
   good share of each will simply drop out as redundant.
3. **Adjudicate the three Copilot variants** (Finding 2) once, and keep one.
4. **Fix the routine itself.** Give it the open-PR list at the start of each run — today's
   run built that exclusion list first and it is the only reason today's findings are not a
   twentieth round of the same bugs. Without it, every future run repeats this.

Consider also having the routine consolidate rather than accumulate: one long-lived
branch that it rebases and extends, instead of a new branch per day.

---

## Appendix — the other new findings, recorded so they are not lost

None of these is urgent and none is pushed. They are cheap, uncontroversial fixes whenever
someone is next in these files.

**A. `token.ts:105` + `:119` — a body of `null` escapes the `OAuthError` contract.**
`text ? JSON.parse(text) : {}` treats the string `"null"` as truthy, so `parsed` becomes
`null` and `parsed.error` two lines later throws a raw `TypeError`. `errors.ts` promises
`catch (e) { if (e instanceof OAuthError) … }` is sufficient, and `refreshTokens`' wrapper
only rewraps `OAuthError`, so the documented "catch `refresh_failed`, prompt a re-login"
branch is skipped. Fires at any status, so a 4xx/5xx page whose body is `null` hits it too.
Every other degenerate shape (`'[]'`, `'3'`, `'true'`, `'"s"'`, `'{}'`, `''`) is handled
correctly — `null` is the only hole. Fix: `parsed === null` guard, or a plain-object check.
Note `registry.ts` already fixes this exact class for the pending record in PR #45.

**B. `fetch.ts:387` — `fetchUserInfo` trusts the userinfo response.**
`return (await response.json()) as UserInfo` with no try, no content-type check and no shape
guard. An HTML 200 (captive portal, CDN error page, proxy interstitial) throws a raw
`SyntaxError`; a body of `null` resolves as a `UserInfo` that throws in the caller on
`.email`. Compare `token.ts:105-113`, which wraps the same operation into
`invalid_token_response`. `docs/content/reference/tokens.mdx:96` teaches
`await fetchUserInfo(client)` with no guard.

**C. `receivers/device.ts:~92-114` — `verification_uri` gets no scheme validation.**
*(Reviewed and rejected as a vulnerability; kept here as low-priority hardening.)*
`expires_in` and `interval` are clamped; the URIs are checked only with
`typeof === 'string'`. A hostile authorization server can return `javascript:…` or
`file:///…`. The CLI itself never navigates to it, and PR #44 already neutralises the
terminal-escape variant, so what remains depends on consumer code that no doc recommends:
every doc occurrence is a `console.log`, and `verificationUri` never reaches `openBrowser()`
in-tree. The attacker would also have to *be* GitHub, Microsoft, Alibaba or xAI, since every
in-tree device provider hardcodes an https host and discovery enforces https on
`device_authorization_endpoint`. One `new URL()` plus a scheme test, whenever someone is
next in the file.

**D. `browser/src/storage.ts:69,95` — a *throwing* storage getter is read as Safari private mode.**
PR #45's `inDocument()` closes the case where the globals are present on a server. It does
not close the case where the getter itself throws: `typeof localStorage` throws inside the
`try`, so control reaches the `/* fall through to memory */` catch and returns a
module-scope `Map` shared by every request — the outcome `unavailableStorage()` exists to
refuse. Reproducible on Node with `--experimental-webstorage` and no `--localstorage-file`.
Narrow, but it survives the backlog's fix.

**E. `redact.ts:40-51` — `TOKEN_SHAPES` omits shapes SECURITY.md implies are covered.**
Google's `1//…` refresh token and Copilot's `tid=…;exp=…;sku=…:<sig>` match no entry, so a
*bare* occurrence in prose (e.g. inside `error_description`) is not scrubbed. The keyed
forms (`refresh_token=1//…`) redact correctly, which is the case SECURITY.md actually
describes, and no real provider is known to echo a bare token. Doc-vs-code gap, not a
demonstrated leak.

### Two documentation errors found incidentally

- `query.ts:59-60` claims last-wins duplicate handling "is what `URLSearchParams.get` would
  return". It is not — `new URLSearchParams('a=1&a=2').get('a')` returns `'1'`. Not
  exploitable (both sides of every `state` comparison go through the same `parseQuery`), but
  the comment is wrong.
- `crypto/adapter.ts` justifies the pure-JS SHA-256 fallback with "a hash handles no
  secrets", but `pkce.ts:32` hashes the PKCE verifier, which is one. The conclusion still
  holds — SHA-256 is unkeyed and the digest is published as the challenge — the sentence is
  just inaccurate. `SECURITY.md` repeats it.

