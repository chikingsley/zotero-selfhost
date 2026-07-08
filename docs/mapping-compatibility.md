# Zotero mapping compatibility

Implemented local surface:

- `GET /items/new` validates item type, attachment link mode, and annotation type.
- Item templates include official attachment link-mode differences for linked URL, linked file, imported URL, imported file, and embedded image.
- Annotation templates include comment/color/page/sort/position fields and type-specific highlight/image/ink fields.
- `computerProgram` templates and field metadata expose `versionNumber` rather than legacy `version`.
- Public metadata routes: `/itemTypes`, `/itemFields`, `/itemTypeFields`, `/itemTypeCreatorTypes`, and `/creatorFields`.
- Basic `locale=fr-FR` handling for item type labels, including `book -> Livre`.

Known unverified areas:

- The official remote mappings test slice has not been run against this Worker.
- Metadata lists are compatibility-minimal and not yet a complete mirror of Zotero's full schema data.
