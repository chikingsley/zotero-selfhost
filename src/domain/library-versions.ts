export type LibraryType = "group" | "user";

export class D1LibraryVersions {
  constructor(private readonly db: D1Database) {}

  async ensure(libraryType: LibraryType, libraryID: number): Promise<void> {
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO libraries (library_type, library_id) VALUES (?, ?)"
      )
      .bind(libraryType, libraryID)
      .run();
  }

  async get(libraryType: LibraryType, libraryID: number): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT version FROM libraries WHERE library_type = ? AND library_id = ?"
      )
      .bind(libraryType, libraryID)
      .first<{ version: number }>();

    return row?.version ?? 0;
  }

  async reserve(
    libraryType: LibraryType,
    libraryID: number,
    count: number,
    expectedVersion: number | null
  ): Promise<number | null> {
    if (count <= 0) {
      return this.get(libraryType, libraryID);
    }

    const row =
      expectedVersion === null
        ? await this.db
            .prepare(
              `UPDATE libraries
               SET version = version + ?,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
               WHERE library_type = ? AND library_id = ?
               RETURNING version`
            )
            .bind(count, libraryType, libraryID)
            .first<{ version: number }>()
        : await this.db
            .prepare(
              `UPDATE libraries
               SET version = version + ?,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
               WHERE library_type = ? AND library_id = ? AND version = ?
               RETURNING version`
            )
            .bind(count, libraryType, libraryID, expectedVersion)
            .first<{ version: number }>();

    return row?.version ?? null;
  }

  async reservePrecondition(
    libraryType: LibraryType,
    libraryID: number,
    objectType: string,
    expectedVersion: number
  ): Promise<boolean> {
    const token = `if-unmodified:${objectType}:${expectedVersion}`;
    const row = await this.db
      .prepare(
        `INSERT INTO write_tokens (library_type, library_id, token)
         VALUES (?, ?, ?)
         ON CONFLICT(library_type, library_id, token) DO NOTHING
         RETURNING token`
      )
      .bind(libraryType, libraryID, token)
      .first<{ token: string }>();

    return Boolean(row);
  }
}
