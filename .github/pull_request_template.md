## What

<!-- What changes, and why. Link an issue if there is one. -->

## Notes for review

<!-- Anything non-obvious: a tradeoff you made, an alternative you rejected,
     a provider quirk you had to work around. -->

## Checklist

- [ ] `pnpm verify` passes (typecheck, build, tests)
- [ ] Tests cover the change — driving the real flow against the fake auth server
      where practical, rather than mocking
- [ ] No client secrets, tokens, or authorization codes in the diff
- [ ] `pnpm changeset` added, if this affects a published package
- [ ] Core still has no dependencies and no platform-specific imports
