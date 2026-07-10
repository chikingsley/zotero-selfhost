export const printHelp = (): void => {
  console.log(`Zotero Self-Host Server

Deploy, migrate, and verify a Zotero-compatible server on Cloudflare.

Run with any package runner:
  npx zotero-selfhost-server setup
  bunx zotero-selfhost-server setup
  pnpx zotero-selfhost-server setup
  yarn dlx zotero-selfhost-server setup

Commands:
  setup                 Provision D1/R2/DO, deploy, and create the first owner key
  setup --existing      Bootstrap an existing Deploy-to-Cloudflare installation
  recover               Create a replacement owner key through Cloudflare auth
  connect               Configure native Zotero Desktop account linking without UI automation
  import                 Plan or execute a resumable Zotero.org personal-library import
  profile                Plan or execute a backed-up Zotero Desktop profile cutover
  profile --rollback     Plan or execute restoration of a profile backup
  acceptance             Run A -> B -> A sync through two disposable Desktop profiles
  admin restore-d1       Restore and verify a D1 SQL backup
  admin copy-r2          Copy and verify every object between two R2 buckets
  admin empty-r2-drill   Empty only an explicitly named restore-drill R2 bucket

Common options:
  --url <https://...>   Worker or custom-domain URL
  --worker <name>       Worker name (default: zotero-selfhost)
  --key-label <label>   Name for the newly created owner key
  --profile <name>      Wrangler authentication profile
  --location <hint>     D1/R2 location hint (for example: wnam)

Direct R2 upload credentials:
  Create an Object Read & Write R2 token scoped only to the attachment bucket.
  Set CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY,
  or pass each value through its corresponding --*-file option.

Migration safety:
  Connect, import, and profile commands are dry-run by default; add --execute to write.
  Put the target owner key in SELFHOST_API_KEY or --api-key-file.
  Put the one-time Zotero.org key in ZOTERO_IMPORT_API_KEY or --zotero-key-file.
  Secrets passed through environment variables or files are never saved by the CLI.

Administrative recovery:
  Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.
  admin restore-d1 --database-id <id> --input <database.sql>
  admin copy-r2 --source-bucket <name> --destination-bucket <name>
  admin empty-r2-drill --bucket <name-containing-restore-drill>
`);
};
