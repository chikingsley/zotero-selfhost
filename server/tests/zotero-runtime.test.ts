import { describe, expect, it } from "vitest";
import { sanitizeZoteroData } from "../src/domain/zotero";

describe("Zotero data sanitization", () => {
  it("preserves valid text whitespace and removes invalid controls", () => {
    expect(
      sanitizeZoteroData({ value: "line one\n\tline two\r\u0000\u0008" })
    ).toEqual({ value: "line one\n\tline two\r" });
  });
});
