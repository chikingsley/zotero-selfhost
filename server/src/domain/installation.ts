import type { Bindings } from "../bindings";
import {
  createKeyStore,
  defaultKeyAccess,
  generateApiKey,
  type KeyInfo,
} from "./keys";

export interface InstallationState {
  bootstrappedAt: string;
  ownerUserID: number;
}

export interface OwnerBootstrapInput {
  displayName: string;
  keyLabel: string;
  username: string;
}

export type OwnerBootstrapResult =
  | { state: "already-bootstrapped" }
  | { apiKey: string; installation: InstallationState; state: "created" };

export interface InstallationStore {
  bootstrapOwner: (input: OwnerBootstrapInput) => Promise<OwnerBootstrapResult>;
  createRecoveryKey: (label: string) => Promise<KeyInfo | null>;
  getState: () => Promise<InstallationState | null>;
}

export const createInstallationStore = (env: Bindings): InstallationStore =>
  new D1InstallationStore(env);

class D1InstallationStore implements InstallationStore {
  private readonly db: D1Database;

  constructor(private readonly env: Bindings) {
    this.db = env.DB;
  }

  async bootstrapOwner(
    input: OwnerBootstrapInput
  ): Promise<OwnerBootstrapResult> {
    if (await this.getState()) {
      return { state: "already-bootstrapped" };
    }

    const apiKey = generateApiKey();
    const access = JSON.stringify(defaultKeyAccess());

    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO users (user_id, username, display_name)
             VALUES (1, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET
               username = excluded.username,
               display_name = excluded.display_name,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
          )
          .bind(input.username, input.displayName),
        this.db.prepare(
          "INSERT INTO installation_state (singleton, owner_user_id) VALUES (1, 1)"
        ),
        this.db
          .prepare(
            `INSERT INTO api_keys
               (api_key, user_id, label, scopes_json, is_owner)
             VALUES (?, 1, ?, ?, 1)`
          )
          .bind(apiKey, input.keyLabel, access),
        this.db.prepare(
          "INSERT OR IGNORE INTO libraries (library_type, library_id) VALUES ('user', 1)"
        ),
      ]);
    } catch (error) {
      if (await this.getState()) {
        return { state: "already-bootstrapped" };
      }
      throw error;
    }

    const installation = await this.getState();
    if (!installation) {
      throw new Error("Installation bootstrap did not persist its state");
    }

    return { apiKey, installation, state: "created" };
  }

  async createRecoveryKey(label: string): Promise<KeyInfo | null> {
    const installation = await this.getState();
    if (!installation) {
      return null;
    }

    return createKeyStore(this.env).createKey({
      isOwner: true,
      name: label,
      userID: installation.ownerUserID,
    });
  }

  async getState(): Promise<InstallationState | null> {
    const row = await this.db
      .prepare(
        `SELECT owner_user_id, bootstrapped_at
         FROM installation_state
         WHERE singleton = 1`
      )
      .first<{ bootstrapped_at: string; owner_user_id: number }>();

    return row
      ? {
          bootstrappedAt: row.bootstrapped_at,
          ownerUserID: row.owner_user_id,
        }
      : null;
  }
}
