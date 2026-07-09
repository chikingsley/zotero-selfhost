import { describe, expect, it } from "vitest";
import { runtimeRequest } from "./runtime";

const compatibilityAdminAuth = `Basic ${btoa(
  "compatibility:runtime-test-admin-token"
)}`;

describe("Atom rendering through the Worker runtime", () => {
  it("preserves Zotero's JSON field order in multi-content entries", async () => {
    const setup = await runtimeRequest("/test/setup?u=1&u2=2", {
      body: " ",
      headers: { Authorization: compatibilityAdminAuth },
      method: "POST",
    });
    const setupBody = (await setup.json()) as {
      user1: { apiKey: string };
    };
    const authorization = `Bearer ${setupBody.user1.apiKey}`;

    const template = await runtimeRequest("/items/new?itemType=book");
    const item = (await template.json()) as Record<string, unknown>;
    item.creators = [
      {
        creatorType: "author",
        firstName: "First",
        lastName: "Last",
      },
    ];
    item.title = "Title";

    const create = await runtimeRequest("/users/1/items", {
      body: JSON.stringify([item]),
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(create.status).toBe(200);

    const atom = await runtimeRequest("/users/1/items?content=bib,json", {
      headers: { Authorization: authorization },
    });
    expect(atom.status).toBe(200);
    const xml = await atom.text();
    const json = xml.match(
      /<zapi:subcontent zapi:type="json">([\s\S]*?)<\/zapi:subcontent>/u
    )?.[1];
    expect(json).toBeTruthy();
    if (!json) {
      throw new Error("Expected JSON Atom subcontent");
    }

    expect(Object.keys(JSON.parse(json))).toEqual([
      "key",
      "version",
      "itemType",
      "title",
      "creators",
      "abstractNote",
      "series",
      "seriesNumber",
      "volume",
      "numberOfVolumes",
      "edition",
      "date",
      "publisher",
      "place",
      "originalDate",
      "originalPublisher",
      "originalPlace",
      "format",
      "numPages",
      "ISBN",
      "DOI",
      "citationKey",
      "url",
      "accessDate",
      "ISSN",
      "archive",
      "archiveLocation",
      "shortTitle",
      "language",
      "libraryCatalog",
      "callNumber",
      "rights",
      "extra",
      "tags",
      "collections",
      "relations",
      "dateAdded",
      "dateModified",
    ]);
  });
});
