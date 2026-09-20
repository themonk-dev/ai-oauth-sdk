---
'@ai-oauth-sdk/browser': patch
---

Address the acknowledgement `announceCallback` waits for, so one sign-in cannot settle another's.

The redirect page announces its callback on a `BroadcastChannel` and waits for a receiver to say it was taken. That acknowledgement carried nothing to say which announcement it answered, and a broadcast reaches every same-origin context — so the first acknowledgement on the channel settled every announcement in flight, not the one the receiver had actually accepted.

Two sign-ins on one origin inside the same 1500ms window are enough: a second tab, or someone who started again after the first window was slow. The receiver picks its own callback by `state` and ignores the other, exactly as it should, and then its acknowledgement told the other redirect page it had been delivered too. That page resolved `true` and closed itself with its code never handed to anyone, leaving the tab waiting on it to hang until its `timeoutMs` — the user has to start over.

Each announcement now carries an id, the receiver echoes it on the acknowledgement, and `announceCallback` settles only on one that names it. The id is a correlation id and nothing more: it travels in clear on a channel every same-origin context can hear, so it says which announcement an acknowledgement belongs to and never that the sender was entitled to send it. Which callback belongs to which attempt is still decided by `state`, as before.

One consequence worth knowing if you load the redirect page from a CDN: a page from this release talking to a receiver from an older one gets an acknowledgement with no id, so it resolves `false` and leaves its window open although the callback did land. That is the reading the return value has always had — "say something, this window is on its own", not "the code was lost".
