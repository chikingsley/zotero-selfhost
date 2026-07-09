import {
  type AttachmentFileRecord,
  createCompatibilityStore,
} from "../../../domain/storage";
import { compatibility } from "../router";
import {
  createStorageStyleRawFileDigest,
  formatAttachmentContentType,
  getPublicationItem,
  isValidMd5,
  parseStorageStyleRawFileLocator,
  requireSignedRawFileURL,
} from "../support";

const rawAttachmentContentType = (file: AttachmentFileRecord): string =>
  file.zip ? "application/zip" : formatAttachmentContentType(file);

compatibility.get("/:md5/:filename", async (c) => {
  const md5 = c.req.param("md5");
  if (!(isValidMd5(md5) && (await requireSignedRawFileURL(c)))) {
    return c.text("File not found", 404);
  }

  const result = await createCompatibilityStore(
    c.env
  ).getAttachmentObjectByStoragePath(md5, c.req.param("filename"));
  if (!result) {
    return c.text("File not found", 404);
  }

  return c.body(result.body, 200, {
    "Content-Disposition": `inline; filename="${result.file.filename}"`,
    "Content-Type": rawAttachmentContentType(result.file),
  });
});

compatibility.get("/:locator/:sha256/:filename", async (c) => {
  const locator = parseStorageStyleRawFileLocator(c.req.param("locator"));
  if (!locator) {
    return c.text("File not found", 404);
  }

  const store = createCompatibilityStore(c.env);
  if (locator.scope === "p") {
    const publication = await getPublicationItem(
      store,
      locator.id,
      locator.itemKey
    );
    if (!publication) {
      return c.text("File not found", 404);
    }
  }

  const result =
    locator.scope === "g"
      ? await store.getGroupAttachmentObject(locator.id, locator.itemKey)
      : await store.getAttachmentObject(locator.id, locator.itemKey);
  if (!result) {
    return c.text("File not found", 404);
  }

  const encodedLocator = encodeURIComponent(
    `${locator.scope}:${locator.id}:${locator.itemKey}`
  );
  const expectedDigest = await createStorageStyleRawFileDigest(
    c,
    encodedLocator,
    result.file.md5
  );
  if (expectedDigest !== c.req.param("sha256")) {
    return c.text("File not found", 404);
  }

  return c.body(result.body, 200, {
    "Content-Disposition": `inline; filename="${result.file.filename}"`,
    "Content-Type": rawAttachmentContentType(result.file),
  });
});
