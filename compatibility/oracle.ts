import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

interface OracleLock {
  commit: string;
  ref: string;
  repository: string;
  schema: {
    sha256: string;
    url: string;
  };
  updatedAt: string;
}

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const repoRoot = resolve(import.meta.dir, "..");
const lockPath = join(import.meta.dir, "oracle.lock.json");
const checkoutPath = join(import.meta.dir, "vendor/dataserver");
const remoteTestsPath = join(checkoutPath, "tests/remote");
const schemaPath = join(checkoutPath, "htdocs/zotero-schema/schema.json");

const sha256 = (data: ArrayBuffer | Uint8Array): string =>
  createHash("sha256").update(new Uint8Array(data)).digest("hex");

const readLock = (): OracleLock => {
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as OracleLock;
  if (!/^\p{ASCII_Hex_Digit}{40}$/v.test(lock.commit)) {
    throw new Error(`Invalid oracle commit in ${lockPath}`);
  }
  if (!/^\p{ASCII_Hex_Digit}{64}$/v.test(lock.schema.sha256)) {
    throw new Error(`Invalid schema digest in ${lockPath}`);
  }
  return lock;
};

const capture = async (
  command: string[],
  cwd = repoRoot
): Promise<CommandResult> => {
  const process = Bun.spawn(command, {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stderr: stderr.trim(), stdout: stdout.trim() };
};

const run = async (command: string[], cwd = repoRoot): Promise<void> => {
  const process = Bun.spawn(command, {
    cwd,
    stderr: "inherit",
    stdout: "inherit",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with code ${exitCode}`);
  }
};

const remoteHead = async (lock: OracleLock): Promise<string> => {
  const result = await capture(["git", "ls-remote", lock.repository, lock.ref]);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to read upstream Zotero ref: ${result.stderr}`);
  }
  const commit = result.stdout.split(/\s+/u)[0] ?? "";
  if (!/^\p{ASCII_Hex_Digit}{40}$/v.test(commit)) {
    throw new Error(`Unexpected ls-remote result: ${result.stdout}`);
  }
  return commit;
};

const fetchSchema = async (
  url: string
): Promise<{ bytes: ArrayBuffer; digest: string }> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to fetch Zotero schema: HTTP ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  return { bytes, digest: sha256(bytes) };
};

const ensureCheckout = async (lock: OracleLock): Promise<void> => {
  let cloned = false;
  if (!existsSync(join(checkoutPath, ".git"))) {
    mkdirSync(dirname(checkoutPath), { recursive: true });
    await run([
      "git",
      "clone",
      "--filter=blob:none",
      lock.repository,
      checkoutPath,
    ]);
    cloned = true;
  }

  const origin = await capture(
    ["git", "remote", "get-url", "origin"],
    checkoutPath
  );
  if (origin.exitCode !== 0 || origin.stdout !== lock.repository) {
    throw new Error(
      `Oracle checkout origin mismatch: expected ${lock.repository}, found ${origin.stdout || "unreadable"}`
    );
  }

  if (!cloned) {
    const dirty = await capture(
      ["git", "status", "--porcelain", "--ignore-submodules=all"],
      checkoutPath
    );
    if (dirty.exitCode !== 0) {
      throw new Error(`Unable to inspect oracle checkout: ${dirty.stderr}`);
    }
    if (dirty.stdout) {
      throw new Error(
        `The managed oracle checkout has local changes:\n${dirty.stdout}`
      );
    }
  }

  const available = await capture(
    ["git", "cat-file", "-e", `${lock.commit}^{commit}`],
    checkoutPath
  );
  if (available.exitCode !== 0) {
    await run(
      ["git", "fetch", "--depth=1", "origin", lock.commit],
      checkoutPath
    );
  }
  await run(["git", "checkout", "--detach", lock.commit], checkoutPath);
};

const writePinnedSchema = async (
  lock: OracleLock,
  prefetched?: ArrayBuffer
): Promise<void> => {
  const schema = prefetched
    ? { bytes: prefetched, digest: sha256(prefetched) }
    : await fetchSchema(lock.schema.url);
  if (schema.digest !== lock.schema.sha256) {
    throw new Error(
      `Zotero schema digest changed: expected ${lock.schema.sha256}, received ${schema.digest}. Run compat:update to review and advance the pin.`
    );
  }
  mkdirSync(dirname(schemaPath), { recursive: true });
  await Bun.write(schemaPath, schema.bytes);
};

const setup = async (
  lock: OracleLock,
  prefetchedSchema?: ArrayBuffer
): Promise<void> => {
  await ensureCheckout(lock);
  await writePinnedSchema(lock, prefetchedSchema);
  await run(["npm", "ci", "--ignore-scripts"], remoteTestsPath);
  console.log(`Oracle ready at ${lock.commit}`);
  console.log(`Schema SHA-256 ${lock.schema.sha256}`);
};

const status = async (lock: OracleLock): Promise<void> => {
  const latest = await remoteHead(lock);
  let checkout = "missing";
  let checkoutClean = false;
  let checkoutOrigin = "missing";
  if (existsSync(join(checkoutPath, ".git"))) {
    const head = await capture(["git", "rev-parse", "HEAD"], checkoutPath);
    checkout = head.exitCode === 0 ? head.stdout : "unreadable";
    const dirty = await capture(
      ["git", "status", "--porcelain", "--ignore-submodules=all"],
      checkoutPath
    );
    checkoutClean = dirty.exitCode === 0 && dirty.stdout.length === 0;
    const origin = await capture(
      ["git", "remote", "get-url", "origin"],
      checkoutPath
    );
    checkoutOrigin = origin.exitCode === 0 ? origin.stdout : "unreadable";
  }

  const localSchemaDigest = existsSync(schemaPath)
    ? sha256(readFileSync(schemaPath))
    : "missing";
  console.log(`Pinned commit:   ${lock.commit}`);
  console.log(`Upstream ${lock.ref}: ${latest}`);
  console.log(`Checkout:        ${checkout}`);
  console.log(`Checkout origin: ${checkoutOrigin}`);
  console.log(`Checkout clean:  ${checkoutClean}`);
  console.log(`Schema pinned:   ${lock.schema.sha256}`);
  console.log(`Schema local:    ${localSchemaDigest}`);
  console.log(
    `Dependencies:    ${existsSync(join(remoteTestsPath, "node_modules")) ? "installed" : "missing"}`
  );
  console.log(`Update available: ${latest !== lock.commit}`);
};

const checkUpstream = async (lock: OracleLock): Promise<void> => {
  const latest = await remoteHead(lock);
  if (latest !== lock.commit) {
    throw new Error(
      `Zotero's ${lock.ref} advanced from ${lock.commit} to ${latest}. Run 'bun run compat:update', review the lock change, and pass the official suite before committing the new pin.`
    );
  }
  console.log(`Zotero oracle pin is current at ${lock.commit}.`);
};

const update = async (lock: OracleLock): Promise<void> => {
  const [latest, schema] = await Promise.all([
    remoteHead(lock),
    fetchSchema(lock.schema.url),
  ]);
  const next: OracleLock = {
    ...lock,
    commit: latest,
    schema: { ...lock.schema, sha256: schema.digest },
    updatedAt: new Date().toISOString().slice(0, 10),
  };

  await setup(next, schema.bytes);
  await Bun.write(lockPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Updated ${lockPath}`);
  console.log(
    "Run the official suite before updating verification-history.md."
  );
};

const main = async (): Promise<void> => {
  const command = Bun.argv[2] ?? "status";
  const lock = readLock();
  if (command === "setup") {
    await setup(lock);
    return;
  }
  if (command === "status") {
    await status(lock);
    return;
  }
  if (command === "check-upstream") {
    await checkUpstream(lock);
    return;
  }
  if (command === "update") {
    await update(lock);
    return;
  }
  throw new Error(`Unknown oracle command: ${command}`);
};

await main();
