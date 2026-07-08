# Zotero Self-Host

A modern, self-hostable server compatible with the Zotero API (v3), built
against Zotero's own test suite as the compatibility oracle.

The method is not to guess Zotero behavior:

1. Use Zotero's official remote API tests as the acceptance oracle.
2. Build a smaller modern server (TypeScript / Bun / Hono) against that oracle.
3. Test real clients once the contract demonstrably holds.

## Status

Most core API slices pass the official test suite fully — see
[compatibility/candidate-status.md](compatibility/candidate-status.md) for the
live scoreboard and
[compatibility/known-differences.md](compatibility/known-differences.md) for
deliberate deviations.

```bash
# run it (in-memory mode)
cd server && bun install && bun scripts/serve.ts

# score it against Zotero's own tests
bun compatibility/run-zotero-tests.ts --target candidate -- -v 3 version
```

"Zotero" is a registered trademark of the Corporation for Digital
Scholarship; this project is an independent, compatible implementation and is
not affiliated with or endorsed by them.

## Key Docs

- [Compatibility status](compatibility/candidate-status.md)
- [Known differences](compatibility/known-differences.md)
- [Compatibility plan](compatibility/README.md)
- [Full server plan](docs/full-server-plan.md)
- [Understanding doc](docs/zotero-selfhost-understanding.md)
- [Candidate server](server/README.md)
- [Active TODO](TODO.md)

## Local Source Inputs (gitignored clones)

- `references/dataserver/`: official Zotero Data Server (AGPL; the test oracle).
- `references/zotero-selfhost/`, `references/zotprime/`: older packaging attempts.
- `references/on-prem-zotero-webui/`: WebDAV PDF proxy plus web-library overlay.
- `references/sources.md`: collected external source links.
