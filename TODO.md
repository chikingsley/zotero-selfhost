# TODO

This file contains open work only. Completed changes belong in `CHANGELOG.md`; measured protocol results belong in `compatibility/candidate-status.md`.

Current status: the production Worker, personal library, attachment storage, migrated Zotero Desktop profile, Cloudflare recovery drill, and live Desktop rollback/re-cutover drill are working. The items below are public-release work and additional compatibility acceptance; they do not indicate that the current personal deployment is broken.

## Release

- [ ] Correct npm trusted-publisher authorization and publish `zotero-selfhost-server` `0.1.3` after the current work can be committed. The `v0.1.1` and `v0.1.2` GitHub workflows reached `npm publish` but failed authorization, so the registry still serves only `0.1.0`; `v0.1.2` remains an unpublished tag on the older commit and should not be moved. The required npm trust record is repository `chikingsley/zotero-selfhost`, workflow filename `publish.yml`, no GitHub environment, and permission to run `npm publish`. After publication, verify the current artifact through `npx` and `bunx`; `pnpx` and `yarn dlx` are documented equivalents and do not need to be installed locally unless separately requested.
- [ ] Validate the Deploy to Cloudflare button from a fresh Cloudflare account.
- [ ] Extend two-Desktop acceptance so A commits, B receives `topicUpdated` without a manual wake-up, B performs a normal sync, and files round-trip in both directions.
