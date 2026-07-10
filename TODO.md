# TODO

This file contains open work only. Completed changes belong in `CHANGELOG.md`; measured protocol results belong in `compatibility/candidate-status.md`.

Current status: the production Worker, personal library, attachment storage, migrated Zotero Desktop profile, Cloudflare recovery drill, and live Desktop rollback/re-cutover drill are working. The items below are public-release work and additional compatibility acceptance; they do not indicate that the current personal deployment is broken.

## Release

- [ ] Complete npm's one-time authorization for the trusted-publisher record, rerun the failed `v0.1.3` publish workflow, verify the published package through `npx` and `bunx`, and create the populated GitHub Release. The committed and tagged package passed GitHub CI and packaging; npmjs still serves `0.1.0` because it rejected the workflow's OIDC identity.
- [ ] Validate the Deploy to Cloudflare button from a fresh Cloudflare account.
- [ ] Extend two-Desktop acceptance so A commits, B receives `topicUpdated` without a manual wake-up, B performs a normal sync, and files round-trip in both directions.
