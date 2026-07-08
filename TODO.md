# TODO

Active queue. Completed product-facing changes move to `CHANGELOG.md`. Completed research findings move into `docs/` or `compatibility/`.

## Now

- [ ] Bring up the official `dataserver` reference stack locally.
- [ ] Run a tiny remote-test slice against the reference stack.
- [x] Create the first compatibility status table from Zotero's v3 tests.
- [x] Add the first repo-owned D1/R2 persistence schema.

## Next

- [x] Write a reference-stack runbook with exact services, config, and reset commands.
- [x] Classify `references/dataserver/tests/remote/tests/3` into MVP, later, and skip.
- [x] Build a compatibility harness that can point the same tests at reference and candidate servers.
- [ ] Replace the placeholder D1 database ID in `server/wrangler.jsonc` when the Cloudflare resource is created.
- [x] Wire item and group compatibility routes to D1-backed storage when the `DB` binding exists.
- [x] Add first attachment file endpoints and R2 object storage flow.
- [x] Add MD5 verification for attachment uploads.
- [x] Add ZIP upload metadata handling for attachment uploads.
- [x] Preserve attachment charset in stored file metadata and download headers.
- [x] Add group item and attachment file route surfaces.
- [x] Add group member persistence and read/edit/file-edit authorization checks.
- [x] Add owner transfer, member removal, and group user listing routes.
- [x] Add anonymous publication item and file route aliases.
- [x] Add signed, expiring raw file URLs.
- [x] Add storage quota admin and upload authorization quota rejection.
- [x] Reject missing file-upload attachment items and mismatched upload sizes.
- [x] Add explicit user/group partial-upload `PATCH` route guards.
- [x] Add Worker-side `bsdiff` partial-upload patch application.
- [x] Add Worker-side `xdelta` and `vcdiff` partial-upload patch application.
- [x] Add Wrangler WASM module bundling config for patch-engine assets.
- [x] Add base user/group collection create, list, and get compatibility routes.
- [x] Wire item collection membership validation and collection item-list routes.
- [x] Derive collection `meta.numItems` from item JSON membership.
- [x] Add item PATCH/PUT collection membership behavior.
- [x] Add collection deletion and recursive child handling.
- [x] Add collection delete version precondition checks.
- [x] Add collection move cycle-breaking for descendant parent moves.
- [ ] Run a Wrangler dry-run build to prove WASM module bundling.
- [ ] Run the official partial-upload file-test slice against the candidate server.

## Later

- [ ] Test Zotero Web Library against the compatible server.
- [ ] Test Zotero Desktop for real-client sync behavior.
- [ ] Add a sample library import/export workflow.
- [ ] Add one-click deployment template after the server shape stabilizes.


## Settings compatibility

- [x] Add user/group settings compatibility routes.
- [x] Add D1 settings table and memory/D1 settings persistence.
- [x] Add settings validation for official allowed names and core value types.
- [x] Add group admin-only settings guard.
- [ ] Run the official remote settings test slice against the Worker.
- [ ] Compare mixed-success settings writereport JSON against the official server.


## Tag compatibility

- [x] Add user/group tag listing routes.
- [x] Add item/tag scoped tag listing routes.
- [x] Add user/group top item list routes for tag-aware filtering.
- [x] Add tag query, since/newer, itemQ, itemTag, and item-list tag filtering helpers.
- [x] Add tag write normalization and validation for item writes.
- [x] Add multi-tag delete that updates linked item JSON and versions.
- [ ] Run the official remote tag test slice against the Worker.
- [x] Add Atom/HEAD parity for tag responses if required by target clients.


## Saved-search compatibility

- [x] Add memory/D1 saved-search persistence with shared library versions.
- [x] Add user/group saved-search CRUD routes.
- [x] Add keys/versions/since/newer/list response handling.
- [x] Add saved-search validation and object-version write guards.
- [x] Add legacy schema invalidProp handling for grouped searches.
- [ ] Run the official remote search test slice against the Worker.
- [ ] Run the official version tests that cover saved searches.
- [x] Add Atom/HEAD parity for saved searches if required by target clients.

## Object API compatibility

- [x] Add create-by-PUT behavior for user/group items, collections, and saved searches.
- [x] Normalize object trash-state writes for item, collection, and saved-search writes.
- [ ] Run the official object remote-test slice against the Worker.
- [ ] Compare exact multi-object GET, delete, unchanged, and failure response parity.

## Version compatibility

- [x] Add `If-Modified-Since-Version` 304 handling for item, collection, tag, search, and settings list endpoints.
- [ ] Run the official version remote-test slice against the Worker.
- [ ] Compare exact version write-report failures for missing/existing objects.
- [ ] Confirm concurrent multi-object write behavior in D1 and memory modes.

## Deleted-sync compatibility

- [x] Add deleted-object store for D1 sync_log and memory mode.
- [x] Add user/group /deleted?since=... routes.
- [x] Add user/group item DELETE routes for single and multi-delete.
- [x] Add memory delete-log recording for item, collection, search, and setting deletes.
- [x] Emit tag delete-log entries when tags are deleted from items.
- [x] Delete related lastPageIndex settings when attachment items are deleted without adding settings to the delete log.
- [ ] Run the official remote deleted-sync and item-delete test slices.


## Mapping compatibility

- [x] Add public metadata routes for item types, fields, creator types, and creator fields.
- [x] Tighten /items/new validation for invalid item types, attachment link modes, and annotation types.
- [x] Add attachment link-mode template differences.
- [x] Add annotation templates for highlight, note, image, ink, underline, and text types.
- [x] Add computerProgram versionNumber field behavior.
- [ ] Run the official remote mappings test slice against the Worker.
- [ ] Expand metadata lists to full Zotero schema parity.

## Schema compatibility

- [x] Add Zotero API/schema response headers.
- [x] Add route-level item field visibility for `lastRead`, Android clients, and empty legacy original-publication fields.
- [ ] Run the official item/schema remote-test slices against the Worker.
- [ ] Replace the fixed schema constant with an embedded or generated current Zotero schema manifest.
- [ ] Expand old-schema field visibility to full Zotero schema parity.

## Annotation compatibility

- [x] Add annotation write normalization and core validation for text, color, sort index, page label, position length, text truncation, and immutable annotation type.
- [x] Add old-schema `invalidProp` marker for EPUB-style and newer annotation responses.
- [x] Add parent attachment PDF/EPUB/HTML validation parity.
- [ ] Run the official annotation remote-test slice against the Worker.
- [ ] Confirm exact sort-index and position-length thresholds against the official dataserver.

## Creator compatibility

- [x] Add creator summary metadata for item JSON responses.
- [x] Add creator summary metadata for item Atom responses.
- [x] Expand creator mapping and write validation to schema 41 item-type creator compatibility.
- [ ] Run the official creator remote-test slice against the Worker.

## Atom compatibility

- [x] Add item Atom selection for `format=atom` and Atom `Accept` headers.
- [x] Add item Atom feed self links and legacy sort/order query normalization.
- [x] Add item Atom multi-content rendering for `content=bib,json`.
- [x] Add item list `HEAD` responses with version and total-result headers.
- [ ] Run the official Atom remote-test slice against the Worker.
- [ ] Calibrate exact Atom feed/entry metadata and CSL bibliography output against the official dataserver.

## Note and child-item compatibility

- [x] Add oversized note validation for item write reports.
- [x] Add user/group item children routes.
- [x] Add Zotero-style note title extraction for Atom titles and title sorting.
- [ ] Run the official remote note and child-item slices against the Worker.
- [ ] Expand note HTML sanitization to full Zotero parity.
## Relation compatibility

- [x] Add item and collection `relations` validation for official Zotero relation predicates.
- [x] Add same-library item reverse `dc:relation` synchronization.
- [ ] Run the official relation remote-test slice against the Worker.
- [ ] Calibrate relation-induced library-version behavior against the official dataserver.

## Full-text compatibility

- [x] Add D1 and memory full-text content/version storage.
- [x] Add user/group full-text content, batch, versions, and index-status routes.
- [x] Include uploaded full-text content in `qmode=everything` item searches.
- [ ] Run the official full-text remote-test slice against the Worker.
- [ ] Implement or intentionally replace the official deindexed/reindexing state machine.
- [ ] Compare full-text batch write-report JSON against the official server.

## API key and login-session compatibility

- [x] Add D1 and memory API key metadata handling.
- [x] Add current/path/user-scoped key info, root list/create, local credential create/update, and delete routes.
- [x] Record API key `lastUsed` metadata from authenticated requests.
- [x] Implement `/keys/sessions` browser login-session create, poll, cancel, info, and complete routes.
- [ ] Run the official key remote-test slice against the Worker.
- [ ] Run the official login-session remote-test slice against the Worker.
- [ ] Add an optional hosted login page for human browser completion.
- [ ] Replace local username/password shims with the final self-host account model.

## Permission compatibility

- [x] Interpret API key user and group access grants for core route guards.
- [x] Filter user note items when the key lacks note access.
- [x] Add anonymous/keyed `/users/:userID/groups` visibility with `Total-Results` and Atom support.
- [x] Apply user write permission guards to every user-library mutation route.
- [x] Match official group Atom content shape and group metadata-version behavior.
- [ ] Run the official permissions remote-test slice against the Worker.

## Group compatibility

- [x] Add group list, individual group read, metadata update, and root search routes.
- [x] Preserve group `description`, `url`, `hasImage`, and metadata `version` in memory and D1 storage.
- [x] Return top-level group metadata in Atom `content=json` responses.
- [x] Bump group metadata versions on metadata and member changes.
- [x] Suppress newly created public groups from root `q` search until they have items.
- [ ] Run the official remote group test slice against the Worker.

## Notification compatibility

- [x] Add official debug notification header encoding.
- [x] Emit item library `topicUpdated` notifications.
- [x] Emit key group-access `topicAdded`/`topicRemoved` notifications.
- [x] Emit group create/delete and group member add/remove notifications.
- [ ] Run the official notification remote-test slice against the Worker.
- [ ] Decide whether production deployments need an actual fan-out service beyond debug headers.

## Export, bibliography, and translation compatibility

- [x] Add item `format=bibtex`, `format=ris`, and `format=csljson` responses.
- [x] Add item `include=bibtex`, `include=ris`, `include=csljson`, `include=citation`, and `include=bib` responses.
- [x] Add item `content=citation`, `content=bib`, `content=csljson`, and `content=json` Atom responses.
- [x] Add local web-translation POST handling for known official-test URLs.
- [ ] Run the official bibliography, export, and translation remote-test slices against the Worker.
- [ ] Decide whether to embed a real CSL/translator engine or keep deterministic Worker-native shims.

## Query parameter, pagination, and sorting compatibility

- [x] Add shared `start`/`limit` pagination and next-link headers for common list renderers.
- [x] Add item list sort/order/direction handling for common fields.
- [x] Add collection, tag, and search list sorting.
- [x] Expand item and collection quick-search behavior.
- [ ] Run the official params and sort remote-test slices against the Worker.
- [ ] Audit uncommon list endpoints for endpoint-specific pagination parity.

## General and cache compatibility

- [x] Preserve duplicate `Zotero-Write-Token` handling.
- [x] Preserve invalid control-character sanitization.
- [x] Add item Atom `content=csljson` and `content=json` support for cache/helper reads.
- [ ] Run the official general and cache remote-test slices against the Worker.

## TTS compatibility

- [x] Add local `/tts/voices`, `/tts/credits`, `/tts/speak`, and `/tts/audio/:audioID` routes.
- [x] Add `TTS_TEST_KEY` binding support.
- [ ] Run the official TTS remote-test slice against the Worker.
- [ ] Replace placeholder WAV generation with a production TTS provider if this server should support real speech.

## Storage-admin compatibility

- [x] Add root-authenticated storage quota read/update routes.
- [x] Support default, numeric, and unlimited quota rendering.
- [ ] Run the official storage-admin remote-test slice against the Worker.
- [ ] Confirm exact XML shape against the official dataserver.
