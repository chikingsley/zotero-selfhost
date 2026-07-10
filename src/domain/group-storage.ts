import type { GroupRecord } from "./state";

export interface CreateGroupInput {
  description?: string;
  fileEditing: string;
  hasImage?: boolean | number | string;
  libraryEditing: string;
  libraryReading: string;
  name: string;
  owner: number;
  type: string;
  url?: string;
}

export interface GroupAccess {
  canAdmin: boolean;
  canEdit: boolean;
  canEditFiles: boolean;
  canRead: boolean;
}

export interface GroupUserInput {
  role: string;
  userID: number;
}

export interface GroupUserRecord {
  role: string;
  userID: number;
}

interface D1GroupRow {
  data_json: string;
  group_id: number;
  library_version: number;
}

const validGroupRoles = new Set(["admin", "member", "owner"]);

const normalizeGroupRole = (role: string): string => {
  if (!validGroupRoles.has(role)) {
    throw new Error(`Invalid role '${role}'`);
  }

  return role;
};

const parseGroupRow = (row: D1GroupRow): GroupRecord => {
  const data = JSON.parse(row.data_json) as GroupRecord["data"];
  return {
    data: {
      ...data,
      id: row.group_id,
      version: row.library_version || data.version || 1,
    },
    id: row.group_id,
  };
};

export class D1GroupStorage {
  constructor(private readonly db: D1Database) {}

  async addUsers(groupID: number, users: GroupUserInput[]): Promise<void> {
    const statements: D1PreparedStatement[] = [];

    for (const user of users) {
      const role = normalizeGroupRole(user.role);
      statements.push(
        this.db
          .prepare("INSERT OR IGNORE INTO users (user_id) VALUES (?)")
          .bind(user.userID),
        this.db
          .prepare(
            `INSERT INTO group_members (group_id, user_id, role)
             VALUES (?, ?, ?)
             ON CONFLICT(group_id, user_id) DO UPDATE SET
               role = excluded.role`
          )
          .bind(groupID, user.userID, role)
      );

      if (role === "owner") {
        const currentOwner = await this.db
          .prepare("SELECT owner_user_id FROM groups WHERE group_id = ?")
          .bind(groupID)
          .first<{ owner_user_id: number }>();

        statements.push(
          this.db
            .prepare("UPDATE groups SET owner_user_id = ? WHERE group_id = ?")
            .bind(user.userID, groupID)
        );
        if (currentOwner && currentOwner.owner_user_id !== user.userID) {
          statements.push(
            this.db
              .prepare(
                `INSERT INTO group_members (group_id, user_id, role)
                 VALUES (?, ?, 'admin')
                 ON CONFLICT(group_id, user_id) DO UPDATE SET role = 'admin'`
              )
              .bind(groupID, currentOwner.owner_user_id)
          );
        }
      }
    }

    if (statements.length > 0) {
      statements.push(
        this.db
          .prepare(
            "UPDATE groups SET library_version = library_version + 1 WHERE group_id = ?"
          )
          .bind(groupID)
      );
      await this.db.batch(statements);
    }
  }

  async create(input: CreateGroupInput): Promise<GroupRecord> {
    await this.ensureUserLibrary(input.owner);

    const idRow = await this.db
      .prepare("SELECT COALESCE(MAX(group_id), 0) + 1 AS id FROM groups")
      .first<{ id: number }>();
    const id = idRow?.id ?? 1;
    const group = {
      data: {
        description: input.description ?? "",
        fileEditing: input.fileEditing,
        hasImage: input.hasImage ?? 0,
        id,
        libraryEditing: input.libraryEditing,
        libraryReading: input.libraryReading,
        name: input.name,
        owner: input.owner,
        type: input.type,
        url: input.url ?? "",
        version: 1,
      },
      id,
    };

    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO groups (group_id, owner_user_id, name, type, library_version, data_json) VALUES (?, ?, ?, ?, 1, ?)"
        )
        .bind(
          id,
          input.owner,
          input.name,
          input.type,
          JSON.stringify(group.data)
        ),
      this.db
        .prepare(
          "INSERT OR IGNORE INTO libraries (library_type, library_id) VALUES ('group', ?)"
        )
        .bind(id),
      this.db
        .prepare(
          "INSERT OR IGNORE INTO group_members (group_id, user_id, role) VALUES (?, ?, 'owner')"
        )
        .bind(id, input.owner),
    ]);

    return group;
  }

  async delete(groupID: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM groups WHERE group_id = ?").bind(groupID),
      this.db
        .prepare(
          "DELETE FROM libraries WHERE library_type = 'group' AND library_id = ?"
        )
        .bind(groupID),
    ]);
  }

  async get(groupID: number): Promise<GroupRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT group_id, library_version, data_json FROM groups WHERE group_id = ?"
      )
      .bind(groupID)
      .first<D1GroupRow>();

    return row ? parseGroupRow(row) : null;
  }

  async getOwnerUserID(groupID: number): Promise<number | null> {
    const row = await this.db
      .prepare("SELECT owner_user_id FROM groups WHERE group_id = ?")
      .bind(groupID)
      .first<{ owner_user_id: number }>();

    return row?.owner_user_id ?? null;
  }

  async getAccess(userID: number, groupID: number): Promise<GroupAccess> {
    const row = await this.db
      .prepare(
        `SELECT G.owner_user_id, G.type, G.data_json, GM.role
         FROM groups G
         LEFT JOIN group_members GM
           ON GM.group_id = G.group_id
          AND GM.user_id = ?
         WHERE G.group_id = ?`
      )
      .bind(userID, groupID)
      .first<{
        data_json: string;
        owner_user_id: number;
        role: string | null;
        type: string;
      }>();

    if (!row) {
      return {
        canAdmin: false,
        canEdit: false,
        canEditFiles: false,
        canRead: false,
      };
    }

    const data = JSON.parse(row.data_json) as GroupRecord["data"];
    const role = row.role ?? (row.owner_user_id === userID ? "owner" : null);
    const isPublic = row.type === "PublicOpen" || row.type === "PublicClosed";
    const canRead =
      Boolean(role) || (isPublic && data.libraryReading === "all");
    const canAdmin = role === "owner" || role === "admin";
    const canEdit =
      canAdmin || (role === "member" && data.libraryEditing === "members");
    const canEditFiles =
      data.fileEditing !== "none" &&
      (canAdmin || (role === "member" && data.fileEditing === "members"));

    return {
      canAdmin,
      canEdit,
      canEditFiles,
      canRead,
    };
  }

  async listUsers(groupID: number): Promise<GroupUserRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT user_id, role
         FROM group_members
         WHERE group_id = ?
         ORDER BY user_id ASC`
      )
      .bind(groupID)
      .all<{ role: string; user_id: number }>();

    return rows.results.map((row) => ({
      role: row.role,
      userID: row.user_id,
    }));
  }

  async listVisible(userID: number): Promise<GroupRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT group_id, library_version, data_json
         FROM groups G
         WHERE owner_user_id = ?
            OR type IN ('PublicOpen', 'PublicClosed')
            OR EXISTS (
              SELECT 1
              FROM group_members GM
              WHERE GM.group_id = G.group_id
                AND GM.user_id = ?
            )
         ORDER BY group_id ASC`
      )
      .bind(userID, userID)
      .all<D1GroupRow>();

    return rows.results.map(parseGroupRow);
  }

  async list(): Promise<GroupRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT group_id, library_version, data_json
         FROM groups
         ORDER BY group_id ASC`
      )
      .all<D1GroupRow>();

    return rows.results.map(parseGroupRow);
  }

  async removeUser(groupID: number, userID: number): Promise<void> {
    const owner = await this.db
      .prepare("SELECT owner_user_id FROM groups WHERE group_id = ?")
      .bind(groupID)
      .first<{ owner_user_id: number }>();

    if (owner?.owner_user_id === userID) {
      return;
    }

    await this.db
      .prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?")
      .bind(groupID, userID)
      .run();
    await this.db
      .prepare(
        "UPDATE groups SET library_version = library_version + 1 WHERE group_id = ?"
      )
      .bind(groupID)
      .run();
  }

  async updateUser(
    groupID: number,
    userID: number,
    role: string
  ): Promise<void> {
    const normalizedRole = normalizeGroupRole(role);

    await this.db
      .prepare("INSERT OR IGNORE INTO users (user_id) VALUES (?)")
      .bind(userID)
      .run();

    if (normalizedRole === "owner") {
      const currentOwner = await this.db
        .prepare("SELECT owner_user_id FROM groups WHERE group_id = ?")
        .bind(groupID)
        .first<{ owner_user_id: number }>();

      await this.db.batch([
        this.db
          .prepare(
            "UPDATE groups SET owner_user_id = ?, library_version = library_version + 1 WHERE group_id = ?"
          )
          .bind(userID, groupID),
        this.db
          .prepare(
            `INSERT INTO group_members (group_id, user_id, role)
             VALUES (?, ?, 'owner')
             ON CONFLICT(group_id, user_id) DO UPDATE SET role = 'owner'`
          )
          .bind(groupID, userID),
        ...(currentOwner && currentOwner.owner_user_id !== userID
          ? [
              this.db
                .prepare(
                  `INSERT INTO group_members (group_id, user_id, role)
                   VALUES (?, ?, 'admin')
                   ON CONFLICT(group_id, user_id) DO UPDATE SET role = 'admin'`
                )
                .bind(groupID, currentOwner.owner_user_id),
            ]
          : []),
      ]);
      return;
    }

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO group_members (group_id, user_id, role)
           VALUES (?, ?, ?)
           ON CONFLICT(group_id, user_id) DO UPDATE SET role = excluded.role`
        )
        .bind(groupID, userID, normalizedRole),
      this.db
        .prepare(
          "UPDATE groups SET library_version = library_version + 1 WHERE group_id = ?"
        )
        .bind(groupID),
    ]);
  }

  async update(
    groupID: number,
    data: Record<string, unknown>
  ): Promise<GroupRecord | null> {
    const existing = await this.get(groupID);
    if (!existing) {
      return null;
    }

    const version = existing.data.version + 1;
    const merged = {
      ...existing.data,
      ...data,
      id: groupID,
      owner:
        typeof data.owner === "number" && Number.isFinite(data.owner)
          ? data.owner
          : existing.data.owner,
      version,
    };
    await this.db
      .prepare(
        `UPDATE groups
         SET owner_user_id = ?,
             name = ?,
             type = ?,
             library_version = ?,
             data_json = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE group_id = ?`
      )
      .bind(
        merged.owner,
        String(merged.name ?? `Group ${groupID}`),
        String(merged.type ?? "Private"),
        version,
        JSON.stringify(merged),
        groupID
      )
      .run();

    return this.get(groupID);
  }

  private async ensureUserLibrary(userID: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("INSERT OR IGNORE INTO users (user_id) VALUES (?)")
        .bind(userID),
      this.db
        .prepare(
          "INSERT OR IGNORE INTO libraries (library_type, library_id) VALUES ('user', ?)"
        )
        .bind(userID),
    ]);
  }
}
