# Daily security audit — 2026-09-26

## Headline

**The detection half of this routine is working. The delivery half has stalled, and the
routine is now working against itself.**

There are **19 open pull requests** from previous runs of this routine, the oldest from
**2026-08-19** — five weeks of daily output, none merged, none reviewed. `main` has not
received a single one of these fixes.

That changes what today's run is worth. The bottleneck is not finding vulnerabilities; it
is that nothing lands. And because every run starts fresh from `main` with no knowledge of
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
