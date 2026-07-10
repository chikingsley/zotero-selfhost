---
name: deploy-zotero-selfhost
description: Deploy, initialize, connect, migrate, verify, or recover a Zotero Self-Host Server installation on Cloudflare. Use when helping a person create or operate their own Worker, D1 database, R2 attachment bucket, Durable Object, owner key, Zotero Desktop connection, or non-destructive Zotero.org import.
license: MIT
compatibility: Requires Node.js 20 or Bun, internet access, a Cloudflare account, and user-controlled Cloudflare and R2 credentials. Zotero Desktop operations require a local Zotero installation.
metadata:
  author: chikingsley
  version: "1.0.0"
---

# Deploy Zotero Self-Host

Use the published `zotero-selfhost-server` CLI for user installations. Use the repository command `bun run cli --` only when the user explicitly wants to test the current source checkout.

Read the repository `README.md` for the public workflow and `docs/cloudflare-production-runbook.md` before any migration, recovery, or custom-domain operation.

## Safety Rules

- Never ask the user to paste API keys or secrets into chat, source files, issues, or command arguments that will be recorded in shell history.
- Prefer private environment variables or permission-restricted key files. Do not print secret values while validating them.
- Treat `connect`, `import`, and `profile` as dry runs until the user reviews the plan and explicitly approves `--execute`.
- Never point compatibility commands, `/test/*` routes, or compatibility credentials at production resources.
- Never delete, revoke, migrate, restore, or replace Cloudflare resources without explicit user approval and a verified backup path.
- Keep Zotero.org as the source of truth until the target import is verified. Import copies data; it must not mutate the Zotero.org library.
- Close Zotero Desktop before any command that edits or migrates a profile.

## Determine The Task

Choose one path before running commands:

1. New installation: run `setup` to provision and initialize Cloudflare resources.
2. Deploy-button installation: run `setup --existing` to finish secrets and first-owner initialization after Cloudflare provisioned the Worker.
3. New or unlinked Desktop profile: run `connect`; do not use the existing-profile migration flow.
4. Existing Zotero.org library: run `import` first, verify the server copy, then use `profile` only if an already-populated Desktop profile must move to the self-hosted identity.
5. Lost owner keys: run `recover` through Cloudflare authentication. Do not reset D1 or R2.
6. Release acceptance: use disposable profiles and the `acceptance` command. Do not reuse the person's primary profile as a test fixture.

## Prerequisites

Confirm without exposing values:

- Node.js 20 or newer, or Bun.
- A Cloudflare account where the user may create Workers, D1, R2, Durable Objects, and Worker secrets.
- `CLOUDFLARE_ACCOUNT_ID`.
- An R2 Object Read & Write token scoped to the intended attachment bucket, provided as `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` or private CLI key files.
- Zotero Desktop installed locally for connection, profile, or acceptance operations.
- A dedicated read-only Zotero.org API key only when importing an existing personal library.

Before a deployment, run the CLI help and state which package source will be used:

```bash
npx zotero-selfhost-server --help
```

## New Installation

Run setup with the user's private environment already loaded:

```bash
npx zotero-selfhost-server setup
```

Setup should authenticate through Wrangler, create or reuse the named D1 database and R2 bucket, apply migrations, deploy the Worker and Durable Object, install the file-signing and R2 credentials as Worker secrets, bootstrap one owner, and return one owner API key.

Record only non-secret results: Worker URL, resource names, health response, and command outcome. Tell the user to store the returned owner key in a password manager. Do not save or echo it elsewhere.

## Deploy To Cloudflare Button

If the button already provisioned the Worker and resources, do not create a second stack. Finish initialization with:

```bash
npx zotero-selfhost-server setup --existing \
  --url https://your-worker.example.workers.dev
```

Verify that setup discovers the intended Worker and installs only the required secrets. If resource names differ from the defaults, pass explicit names instead of guessing.

## Connect A New Desktop Profile

Close Zotero, inspect the plan, and then execute it:

```bash
npx zotero-selfhost-server connect --url https://your-worker.example.com
npx zotero-selfhost-server connect --url https://your-worker.example.com --execute
```

Reopen Zotero and direct the user to **Settings → Sync → Link Account**. The browser must open the login page on the user's own Worker. The owner key authorizes the request once; Zotero receives and stores a separate device key.

Verify the selected profile and custom API and streaming URLs. Do not use Run JavaScript or profile migration for normal new-profile onboarding.

## Import An Existing Personal Library

Load `ZOTERO_IMPORT_API_KEY` from a dedicated Zotero.org key and `SELFHOST_API_KEY` from the target owner key. Run the inventory first:

```bash
npx zotero-selfhost-server import --url https://your-worker.example.com
```

Report source counts, target plan, retrievable attachments, unavailable attachment metadata, and any recovery-manifest requirement without exposing titles or private content unnecessarily.

After user approval, execute the resumable import:

```bash
npx zotero-selfhost-server import --url https://your-worker.example.com --execute
```

Do not switch an existing Desktop profile until the import completes and target verification passes.

## Migrate An Existing Desktop Profile

With Zotero fully closed, run the profile command without `--execute` and report the selected profile, backup location, target URL, and import-state verification. Then require explicit approval before:

```bash
npx zotero-selfhost-server profile --url https://your-worker.example.com --execute
```

Do not delete the generated backup. If verification fails, stop and preserve the profile, backup, import state, and operation logs. Roll back only from the exact recorded backup:

```bash
npx zotero-selfhost-server profile --rollback /path/to/backup --execute
```

## Recover Owner Access

If every owner key is lost, authenticate to the owning Cloudflare account and run:

```bash
npx zotero-selfhost-server recover --url https://your-worker.example.com
```

Confirm that the command creates a replacement owner key without resetting D1 or R2 and removes the temporary recovery secret. If secret removal fails, stop and direct the user to remove that temporary Worker secret in Cloudflare before continuing.

## Verification

At minimum, verify:

- The Worker health endpoint responds from the intended URL.
- Production returns `404` for `/test/*`.
- The owner key identifies the expected self-host user without printing the key.
- Zotero Desktop links through the native login flow and performs an ordinary sync.
- Imported library counts and attachment verification match the accepted import plan.
- Streaming uses the same origin with `/stream` and authenticated subscriptions.
- No disposable acceptance records, device keys, temporary profiles, or temporary secrets remain after a completed test.

For release acceptance, use:

```bash
npx zotero-selfhost-server acceptance --url https://your-worker.example.com
```

Run the acceptance command as a dry run first. Use only disposable Desktop profiles and explicitly approved test records.

## Handoff

Give the user a short factual summary containing the Worker URL, non-secret resource names, completed verification steps, remaining manual actions, and any retained backup locations. Distinguish provisioned, initialized, imported, connected, synchronized, and live-verified states. Never claim one state merely because another succeeded.
