# Atom compatibility

Status: partially implemented locally, not yet verified against the official Atom remote-test slice.

## Implemented

- Item list and single-item routes return Atom when `format=atom` is requested.
- Item list routes return Atom when the `Accept` header includes `application/atom+xml` and no explicit `format` overrides it.
- `format=json` continues to override an Atom `Accept` header.
- Item list Atom feeds include a canonical self link.
- Legacy `order=field&sort=asc|desc` query strings are normalized to `sort=field&direction=asc|desc` in the Atom feed self link.
- `content=bib,json` renders multi-content Atom entries with `zapi:subcontent` nodes.
- Item list `HEAD` routes return `Last-Modified-Version` and `Total-Results` without a body.

## Remaining calibration

- Run the official Atom remote-test slice against this Worker.
- Replace deterministic bibliography shims with exact CSL output if full Atom content parity is required.
- Confirm exact feed/entry metadata fields, timestamps, links, and XML formatting against the official dataserver.
