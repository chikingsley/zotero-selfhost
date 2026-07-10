# TODO

This file contains open work only. Completed changes belong in `CHANGELOG.md`; dated protocol results belong in `compatibility/verification-history.md`.

Current status: the production Worker, personal library, attachment storage, migrated Zotero Desktop profile, Cloudflare recovery drill, and live Desktop rollback/re-cutover drill are working. The items below are public-release work and additional compatibility acceptance; they do not indicate that the current personal deployment is broken.

## Release

- [ ] Validate the Deploy to Cloudflare button from a fresh Cloudflare account.
- [ ] Extend two-Desktop acceptance so A commits, B receives `topicUpdated` without a manual wake-up, B performs a normal sync, and files round-trip in both directions.
