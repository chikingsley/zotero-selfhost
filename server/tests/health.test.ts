import { describe, expect, it } from "vitest";
import app from "../src/index";

interface OpenApiDocument {
  info: {
    title: string;
  };
  paths: Record<string, unknown>;
}

describe("health route", () => {
  it("returns service health", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "zotero-compatible-server",
    });
  });

  it("serves an OpenAPI document", async () => {
    const response = await app.request("/openapi.json");
    expect(response.status).toBe(200);
    const body = (await response.json()) as OpenApiDocument;
    expect(body.info.title).toBe("Zotero Compatible Server");
    expect(body.paths["/health"]).toBeDefined();
  });
});
