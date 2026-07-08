# TODO

Active queue. Completed product-facing changes move to `CHANGELOG.md`.
Current oracle scores live in `compatibility/candidate-status.md`.

## Now

- [ ] Drive `item` slice to green (88/109; finisher pass in progress).
- [ ] Fix remaining `tag` failure (orphaned tag).
- [ ] Group `server/src/routes/compatibility/` into subfolders (cosmetic; after green).

## Next

- [ ] Run the not-yet-scored slices (`keys`, `permissions`, `loginSessions`, `group`, `mappings`, `creator`, `relation`, `sort`, `params`, `cache`, `atom`, `bib`, `export`, `fulltext`, `publications`, `storage-admin`) and triage.
- [ ] Stand up an S3-compatible store (MinIO/R2) + TLS to unlock the 3 environment-bound `file` tests (see `compatibility/known-differences.md`).
- [ ] Oracle-verify the D1/R2 (Cloudflare) storage path — memory mode is the verified path today; D1 has received parity edits but no end-to-end runs.
- [ ] Replace the placeholder D1 database ID in `server/wrangler.jsonc` when the Cloudflare resource is created.
- [ ] Run a Wrangler dry-run build to prove WASM module bundling.

## Real clients (the actual finish line)

- [ ] Point Zotero Web Library at the candidate server and sync.
- [ ] Point Zotero Desktop (custom API endpoint) at the candidate and sync a real library.
- [ ] Sample library import/export workflow.
- [ ] One-click deployment template once the server shape stabilizes.

## Product

- [ ] Pick a product name (the "Zotero" name is trademarked — "compatible with Zotero" phrasing only; see references/dataserver/COPYING).
- [ ] Choose a license for this repo (server code is original; MIT/Apache both viable).
- [ ] Decide the auth story for real deployments (current: test-setup shim + API keys; needs a real account model).
