import { describe, expect, it } from "vitest";
import { runtimeRequest } from "./runtime";

interface OpenApiDocument {
  info: {
    title: string;
  };
  paths: Record<string, unknown>;
}

describe("health route", () => {
  it("returns service health", async () => {
    const response = await runtimeRequest("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "zotero",
    });
  });

  it("serves an OpenAPI document", async () => {
    const response = await runtimeRequest("/openapi.json");
    expect(response.status).toBe(200);
    const body = (await response.json()) as OpenApiDocument;
    expect(body.info.title).toBe("Zotero");
    expect(body.paths["/health"]).toBeDefined();
  });
});
