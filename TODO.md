# TODO

This file contains open work only. Completed changes belong in `CHANGELOG.md`; measured protocol results belong in `compatibility/candidate-status.md`.

Current status: the production Worker, personal library, attachment storage, and migrated Zotero Desktop profile are working. The items below are public-release work, additional rollback and failure drills, product decisions, and later simplification; they do not indicate that the current personal deployment is broken.

## Release

- [ ] Exercise the explicit Desktop rollback command against the real migration backup, verify the Zotero.org profile restoration, and repeat the cutover.
- [ ] Publish `zotero-selfhost-server` to npm and execute all four documented package-runner forms against the published artifact.
- [ ] Make the repository public and validate the Deploy to Cloudflare button from a fresh Cloudflare account.
- [ ] Deploy an isolated compatibility Worker with the new authentication boundary and rerun the complete pinned official suite.
- [ ] Run the disposable Zotero Desktop smoke test against the compatibility deployment, including its streaming URL.
- [ ] Extend two-Desktop acceptance so A commits, B receives `topicUpdated` without a manual wake-up, B performs a normal sync, and files round-trip in both directions.
- [ ] Exercise Durable Object eviction and reconnection behavior plus invalid and revoked key behavior.
- [ ] Add a repeatable recovery exercise that restores a current production D1 export and R2 backup into disposable resources and verifies the result.

## Product decision

- [ ] Decide the stock-mobile strategy: upstream custom-server support, a maintained fork, or the future first-party app.

## Simplification

- [ ] Split the largest D1 store and compatibility-support modules by domain now that migration and two-device tests cover their public behavior.
- [ ] Consolidate repeated library-version reservation, authorization, paging, and notification-publication helpers.
- [ ] Remove remaining compatibility-only branches from production modules where a dedicated test adapter can preserve the pinned oracle unchanged.
- [ ] Re-measure bundle size, D1 query counts, and mutation latency after each consolidation pass.
