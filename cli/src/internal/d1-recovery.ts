import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

interface D1Result {
  error?: unknown;
  results?: Record<string, unknown>[];
  success?: boolean;
}

interface D1Envelope {
  errors?: unknown;
  result?: D1Result[];
  success?: boolean;
}

interface SchemaEntry {
  name: string;
  sql: string;
}

interface D1RestoreOptions {
  accountID: string;
  apiToken: string;
  databaseID: string;
  inputPath: string;
}

interface ReadonlyDatabase {
  close: () => void;
  query: (sql: string) => {
    all: () => unknown[];
    get: () => unknown;
  };
}

const openReadonlyDatabase = (path: string): ReadonlyDatabase => {
  const readRows = (sql: string): Record<string, unknown>[] => {
    const result = spawnSync("sqlite3", ["-json", path, sql], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(`Could not inspect the SQLite backup: ${result.stderr}`);
    }
    return result.stdout.trim()
      ? (JSON.parse(result.stdout) as Record<string, unknown>[])
      : [];
  };
  return {
    close: () => undefined,
    query: (sql) => ({
      all: () => readRows(sql),
      get: () => readRows(sql)[0],
    }),
  };
};

const quoteIdentifier = (value: string): string =>
  `"${value.replaceAll('"', '""')}"`;

export const restoreD1 = async ({
  accountID,
  apiToken,
  databaseID,
  inputPath,
}: D1RestoreOptions): Promise<void> => {
  const queryURL = `https://api.cloudflare.com/client/v4/accounts/${accountID}/d1/database/${databaseID}/query`;
  const queryD1 = async (
    sql: string,
    params: unknown[] = []
  ): Promise<D1Result> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const response = await fetch(queryURL, {
          body: JSON.stringify({ params, sql }),
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        const envelope = (await response.json()) as D1Envelope;
        const result = envelope.result?.[0];
        if (
          response.ok &&
          envelope.success &&
          result &&
          result.success !== false
        ) {
          return result;
        }
        const details = JSON.stringify(
          envelope.errors ?? result?.error ?? envelope
        );
        if (response.status < 500 && response.status !== 429) {
          throw new Error(`D1 query failed (${response.status}): ${details}`);
        }
        lastError = new Error(
          `D1 query failed (${response.status}): ${details}`
        );
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, 250 * 2 ** attempt)
      );
    }
    throw lastError;
  };

  const sqlPath = resolve(inputPath);
  const workDirectory = await mkdtemp(join(tmpdir(), "zotero-d1-restore-"));
  const localDatabasePath = join(workDirectory, "restore.sqlite");

  try {
    console.log(
      `Preparing ${basename(sqlPath)} for a parameterized D1 restore...`
    );
    const dump = await readFile(sqlPath);
    const imported = spawnSync("sqlite3", [localDatabasePath], {
      input: dump,
      maxBuffer: 1024 * 1024,
    });
    if (imported.status !== 0) {
      throw new Error(`Could not read the SQL backup: ${imported.stderr}`);
    }

    const database = openReadonlyDatabase(localDatabasePath);
    const tables = database
      .query(
        "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_cf_KV' ORDER BY rowid"
      )
      .all() as SchemaEntry[];
    const secondarySchema = database
      .query(
        "SELECT type, name, sql FROM sqlite_schema WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL ORDER BY rowid"
      )
      .all() as SchemaEntry[];

    console.log(
      `Creating ${tables.length} tables in disposable D1 database...`
    );
    for (const table of tables) {
      await queryD1(table.sql);
    }

    let restoredRows = 0;
    for (const table of tables) {
      const tableName = String(table.name);
      const identifier = quoteIdentifier(tableName);
      const columns = database
        .query(`PRAGMA table_info(${identifier})`)
        .all() as { name: string }[];
      const columnNames = columns.map((column) => String(column.name));
      const rows = database
        .query(`SELECT * FROM ${identifier}`)
        .all() as Record<string, unknown>[];
      if (rows.length === 0) {
        console.log(`${tableName}: empty`);
        continue;
      }

      const maxRowsByVariables = Math.max(
        1,
        Math.floor(90 / columnNames.length)
      );
      for (let offset = 0; offset < rows.length; ) {
        const batch: Record<string, unknown>[] = [];
        let serializedBytes = 0;
        while (offset + batch.length < rows.length) {
          const candidate = rows[offset + batch.length];
          const candidateBytes = Buffer.byteLength(JSON.stringify(candidate));
          if (
            batch.length > 0 &&
            (batch.length >= maxRowsByVariables ||
              serializedBytes + candidateBytes > 1_800_000)
          ) {
            break;
          }
          batch.push(candidate);
          serializedBytes += candidateBytes;
        }

        const rowPlaceholders = `(${columnNames.map(() => "?").join(", ")})`;
        const statement = `INSERT INTO ${identifier} (${columnNames.map(quoteIdentifier).join(", ")}) VALUES ${batch.map(() => rowPlaceholders).join(", ")}`;
        const params = batch.flatMap((row) =>
          columnNames.map((column) => row[column])
        );
        await queryD1(statement, params);
        offset += batch.length;
        restoredRows += batch.length;
      }
      console.log(`${tableName}: ${rows.length} rows`);
    }

    console.log(
      `Creating ${secondarySchema.length} indexes, triggers, and views...`
    );
    for (const entry of secondarySchema) {
      await queryD1(entry.sql);
    }

    for (const table of tables) {
      const tableName = String(table.name);
      const identifier = quoteIdentifier(tableName);
      const sourceCount = Number(
        (
          database
            .query(`SELECT count(*) AS count FROM ${identifier}`)
            .get() as {
            count: number;
          }
        ).count
      );
      const remote = await queryD1(
        `SELECT count(*) AS count FROM ${identifier}`
      );
      const restoredCount = Number(remote.results?.[0]?.count);
      if (sourceCount !== restoredCount) {
        throw new Error(
          `${tableName} verification failed: expected ${sourceCount}, restored ${restoredCount}`
        );
      }
    }

    database.close();
    console.log(
      JSON.stringify(
        {
          databaseID,
          restoredRows,
          status: "verified",
          tables: tables.length,
        },
        null,
        2
      )
    );
  } finally {
    await rm(workDirectory, { force: true, recursive: true });
  }
};
