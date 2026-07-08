# Zotero Self-Host

Research and prototype workspace for a full Zotero-compatible self-hosted server.

The plan is not to guess Zotero behavior. The plan is:

1. Run the official Zotero `dataserver` locally as the reference stack.
2. Use Zotero's own remote API tests as the compatibility oracle.
3. Build a smaller modern compatible server against that oracle.
4. Test real clients only after the server contract is understood.

## Current Tracks

- Reference stack: official `zotero/dataserver` plus required services.
- Compatibility map: phased subset of official API tests.
- Compatible server: future implementation, likely single-user first.
- Companion/WebUI: useful side path for PDF access, but not the full sync server.

## Key Docs

- [Full server plan](docs/full-server-plan.md)
- [Understanding doc](docs/zotero-selfhost-understanding.md)
- [Compatibility plan](compatibility/README.md)
- [References](references/README.md)
- [Candidate server](server/README.md)
- [Active TODO](TODO.md)

## Local Source Inputs

- `references/dataserver/`: official Zotero Data Server.
- `references/zotero-selfhost/`: older full-stack Docker/package attempt.
- `references/zotprime/`: older on-prem package attempt.
- `references/on-prem-zotero-webui/`: WebDAV PDF proxy plus web-library overlay.
- `references/sources.md`: collected external source links.
