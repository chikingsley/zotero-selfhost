import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src";
import type { Bindings } from "../src/bindings";
import { runtimeRequest } from "./runtime";

describe("owner bootstrap and recovery", () => {
  it("does not expose destructive or password-login routes in production mode", async () => {
    const productionEnv = {
      ATTACHMENTS: env.ATTACHMENTS,
      DB: env.DB,
      DEPLOYMENT_MODE: "production",
      FILE_URL_SIGNING_SECRET: env.FILE_URL_SIGNING_SECRET,
      STREAM_HUB: env.STREAM_HUB,
    } satisfies Bindings;
    const executionContext = createExecutionContext();

    const setup = await app.request(
      "https://zotero.test/test/setup?u=1&u2=2",
      {
        headers: {
          Authorization: `Basic ${btoa(
            "compatibility:runtime-test-admin-token"
          )}`,
        },
        method: "POST",
      },
      productionEnv,
      executionContext
    );
    expect(setup.status).toBe(404);

    const passwordLogin = await app.request(
      "https://zotero.test/keys",
      {
        body: JSON.stringify({ password: "anything", username: "owner" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
      productionEnv,
      executionContext
    );
    expect(passwordLogin.status).toBe(404);
  });

  it("creates one owner and recovers without a permanent root password", async () => {
    const rejected = await runtimeRequest("/_selfhost/bootstrap", {
      body: JSON.stringify({ username: "owner" }),
      headers: {
        Authorization: "Bearer wrong-token",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(rejected.status).toBe(403);

    const bootstrap = await runtimeRequest("/_selfhost/bootstrap", {
      body: JSON.stringify({
        displayName: "Library Owner",
        keyLabel: "First desktop",
        username: "owner",
      }),
      headers: {
        Authorization: "Bearer runtime-bootstrap-token",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(bootstrap.status).toBe(201);
    const bootstrapBody = (await bootstrap.json()) as {
      apiKey: string;
      ownerUserID: number;
    };
    expect(bootstrapBody.apiKey).toHaveLength(24);
    expect(bootstrapBody.ownerUserID).toBe(1);

    const persisted = await env.DB.prepare(
      "SELECT user_id, label, is_owner FROM api_keys WHERE api_key = ?"
    )
      .bind(bootstrapBody.apiKey)
      .first<{ is_owner: number; label: string; user_id: number }>();
    expect(persisted).toEqual({
      is_owner: 1,
      label: "First desktop",
      user_id: 1,
    });

    const duplicate = await runtimeRequest("/_selfhost/bootstrap", {
      body: "{}",
      headers: {
        Authorization: "Bearer runtime-bootstrap-token",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(duplicate.status).toBe(409);

    const deviceKey = await runtimeRequest("/users/1/keys", {
      body: JSON.stringify({ name: "Second desktop" }),
      headers: {
        Authorization: `Bearer ${bootstrapBody.apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(deviceKey.status).toBe(201);

    const template = await runtimeRequest("/items/new?itemType=book");
    const item = (await template.json()) as Record<string, unknown>;
    item.title = "Owner identity";
    const create = await runtimeRequest("/users/1/items", {
      body: JSON.stringify([item]),
      headers: {
        Authorization: `Bearer ${bootstrapBody.apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const createBody = (await create.json()) as {
      success: Record<string, string>;
    };
    const itemKey = createBody.success["0"];
    expect(itemKey).toBeTruthy();
    if (!itemKey) {
      throw new Error("Expected a bootstrapped owner item key");
    }
    const fetched = await runtimeRequest(`/users/1/items/${itemKey}`, {
      headers: { Authorization: `Bearer ${bootstrapBody.apiKey}` },
    });
    const fetchedBody = (await fetched.json()) as {
      library: { name: string };
    };
    expect(fetchedBody.library.name).toBe("Library Owner");

    const recovery = await runtimeRequest("/_selfhost/recovery/keys", {
      body: JSON.stringify({ keyLabel: "Recovered owner" }),
      headers: {
        Authorization: "Bearer runtime-recovery-token",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(recovery.status).toBe(201);
    const recoveryBody = (await recovery.json()) as {
      key: { key: string; name: string };
    };
    expect(recoveryBody.key.key).toHaveLength(24);
    expect(recoveryBody.key.name).toBe("Recovered owner");

    const owners = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM api_keys WHERE is_owner = 1 AND revoked_at IS NULL"
    ).first<{ count: number }>();
    expect(owners?.count).toBe(2);
  });

  it("completes Zotero's native browser login as the installation owner", async () => {
    const owner = await env.DB.prepare(
      "SELECT api_key, user_id FROM api_keys WHERE label = 'First desktop' AND is_owner = 1 AND revoked_at IS NULL"
    ).first<{ api_key: string; user_id: number }>();
    expect(owner).toBeTruthy();
    if (!owner) {
      throw new Error("Expected the bootstrapped owner key");
    }

    const createSession = await runtimeRequest("/keys/sessions", {
      body: JSON.stringify({ userID: 16_689_138 }),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Zotero/9.0 (macOS)",
      },
      method: "POST",
    });
    expect(createSession.status).toBe(201);
    const session = (await createSession.json()) as {
      loginURL: string;
      sessionToken: string;
    };
    expect(session.loginURL).toBe(
      `https://zotero.test/login?session=${session.sessionToken}`
    );

    const loginPage = await runtimeRequest(
      `/login?session=${session.sessionToken}`
    );
    expect(loginPage.status).toBe(200);
    expect(await loginPage.text()).toContain("Connect Zotero Desktop");

    const invalid = await runtimeRequest("/login", {
      body: new URLSearchParams({
        ownerApiKey: "not-an-owner-key",
        session: session.sessionToken,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    expect(invalid.status).toBe(403);

    const complete = await runtimeRequest("/login", {
      body: new URLSearchParams({
        ownerApiKey: owner.api_key,
        session: session.sessionToken,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    expect(complete.status).toBe(200);
    expect(await complete.text()).toContain("Zotero connected");

    const status = await runtimeRequest(
      `/keys/sessions/${session.sessionToken}`
    );
    expect(status.status).toBe(200);
    const result = (await status.json()) as {
      apiKey: string;
      status: string;
      userID: number;
      username: string;
    };
    expect(result).toMatchObject({
      status: "completed",
      userID: owner.user_id,
      username: "owner",
    });
    expect(result.apiKey).toHaveLength(24);

    const device = await env.DB.prepare(
      "SELECT user_id, label, is_owner FROM api_keys WHERE api_key = ?"
    )
      .bind(result.apiKey)
      .first<{ is_owner: number; label: string; user_id: number }>();
    expect(device).toEqual({
      is_owner: 0,
      label: "Zotero macOS Login",
      user_id: owner.user_id,
    });
  });
});
