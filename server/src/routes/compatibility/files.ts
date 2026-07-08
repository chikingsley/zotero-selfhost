import { parseNumericID, requireUser, requireUserWrite, isValidMd5, supportedPartialUploadAlgorithms, parseFileParams, getUploadBaseURL, getRawFileURL, getPublicationRawFileURL, getGroupUploadBaseURL, getGroupRawFileURL, parseUploadBody, responseBodyToArrayBuffer, formatAttachmentContentType, requireSignedRawFileURL, checkStorageQuota, requireGroup, requireGroupFileEdit, getPublicationItem, renderPublicationItemAtom, withPublicationLinks } from "./shared";
import { applyZoteroPatch, PatchAlgorithmUnavailableError } from "../../patch";
import { createCompatibilityStore } from "../../storage";
import { compatibility } from "./router";


compatibility.post(
  "/groups/:groupID/items/:itemKey/file/upload/:uploadKey",
  async (c) => {
    const groupID = parseNumericID(c.req.param("groupID"));
    if (groupID === null) {
      return c.text("Invalid groupID", 400);
    }

    const body = await parseUploadBody(c.req.raw);
    const result = await createCompatibilityStore(c.env).storeAttachmentUpload(
      c.req.param("uploadKey"),
      body,
      c.req.header("Content-Type")
    );

    if (!result.found) {
      return c.text("Upload key not found", 400);
    }
    if (result.hashMismatch) {
      return c.text(
        "The Content-MD5 you specified did not match what we received",
        400
      );
    }
    if (result.sizeMismatch) {
      return c.text(
        "Your proposed upload exceeds the maximum allowed size",
        400
      );
    }

    return c.body(null, 201);
  }
);


compatibility.get(
  "/groups/:groupID/items/:itemKey/file/raw/:md5/:filename",
  async (c) => {
    const groupID = parseNumericID(c.req.param("groupID"));
    if (groupID === null) {
      return c.text("Invalid groupID", 400);
    }

    const result =
      await createCompatibilityStore(c.env).getGroupAttachmentObject(
        groupID,
        c.req.param("itemKey")
      );

    if (!(await requireSignedRawFileURL(c))) {
      return c.text("Invalid file URL", 403);
    }

    if (!result || result.file.md5 !== c.req.param("md5")) {
      return c.text("File not found", 404);
    }

    return c.body(result.body, 200, {
      "Content-Disposition": `inline; filename="${result.file.filename}"`,
      "Content-Type": formatAttachmentContentType(result.file),
    });
  }
);


compatibility.get(
  "/groups/:groupID/items/:itemKey/file/view/url",
  async (c) => {
    const groupID = parseNumericID(c.req.param("groupID"));
    if (groupID === null) {
      return c.text("Invalid groupID", 400);
    }

    const store = createCompatibilityStore(c.env);
    if (!(await requireGroup(c, store, groupID))) {
      return c.text("Invalid key", 403);
    }

    const file = await store.getGroupAttachmentFile(
      groupID,
      c.req.param("itemKey")
    );
    if (!file) {
      return c.text("File not found", 404);
    }

    return c.text(
      await getGroupRawFileURL(
        c,
        groupID,
        c.req.param("itemKey"),
        file.md5,
        file.filename
      )
    );
  }
);


compatibility.get("/groups/:groupID/items/:itemKey/file/view", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const file = await store.getGroupAttachmentFile(
    groupID,
    c.req.param("itemKey")
  );
  if (!file) {
    return c.text("File not found", 404);
  }

  return c.redirect(
    await getGroupRawFileURL(c, groupID, c.req.param("itemKey"), file.md5, file.filename),
    302
  );
});


compatibility.patch("/groups/:groupID/items/:itemKey/file", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const itemKey = c.req.param("itemKey");
  if (!(await store.getGroupItem(groupID, itemKey))) {
    return c.text("Item not found", 404);
  }

  const uploadKey = c.req.query("upload");
  if (!uploadKey) {
    return c.text("Upload key not provided", 400);
  }

  const algorithm = c.req.query("algorithm");
  if (!algorithm) {
    return c.text("Algorithm not specified", 400);
  }
  if (!supportedPartialUploadAlgorithms.has(algorithm)) {
    return c.text(`Invalid algorithm '${algorithm}'`, 400);
  }

  const ifMatch = c.req.header("If-Match")?.replaceAll('"', "");
  if (!ifMatch) {
    return c.text("If-Match/If-None-Match header not provided", 428);
  }
  if (!isValidMd5(ifMatch)) {
    return c.text("Invalid ETag in If-Match header", 400);
  }

  const existingFile = await store.getGroupAttachmentFile(groupID, itemKey);
  if (!existingFile) {
    return c.text("If-Match set but file does not exist", 412);
  }
  if (existingFile.md5 !== ifMatch) {
    return c.text("ETag does not match current version of file", 412);
  }

  const original = await store.getGroupAttachmentObject(groupID, itemKey);
  if (!original) {
    return c.text("File not found", 404);
  }

  let patched: ArrayBuffer;
  try {
    patched = await applyZoteroPatch(
      algorithm,
      await responseBodyToArrayBuffer(original.body),
      await c.req.raw.arrayBuffer()
    );
  } catch (error) {
    if (error instanceof PatchAlgorithmUnavailableError) {
      return c.text(
        "Partial upload patch engine is not available in the Worker runtime yet",
        501
      );
    }

    return c.text("Error applying patch", 400);
  }

  const uploadResult = await store.storeAttachmentUpload(uploadKey, patched);
  if (!uploadResult.found) {
    return c.text("Upload key not found", 400);
  }
  if (uploadResult.hashMismatch) {
    return c.text("Patched file does not match hash", 409);
  }
  if (uploadResult.sizeMismatch) {
    return c.text("Patched file size does not match", 409);
  }

  const result = await store.registerGroupAttachmentUpload(
    groupID,
    itemKey,
    uploadKey
  );
  if (!result.registered) {
    return c.text("Upload key not found", 400);
  }

  return c.body(null, 204, {
    "Last-Modified-Version": `${result.version}`,
  });
});


compatibility.get("/groups/:groupID/items/:itemKey/file", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const file = await store.getGroupAttachmentFile(
    groupID,
    c.req.param("itemKey")
  );
  if (!file) {
    return c.text("File not found", 404);
  }

  return c.redirect(
    await getGroupRawFileURL(c, groupID, c.req.param("itemKey"), file.md5, file.filename),
    302
  );
});


compatibility.post("/groups/:groupID/items/:itemKey/file", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupFileEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const itemKey = c.req.param("itemKey");
  if (!(await store.getGroupItem(groupID, itemKey))) {
    return c.text("Item not found", 404);
  }

  const params = await parseFileParams(c);
  const ifMatch = c.req.header("If-Match")?.replaceAll('"', "");
  const ifNoneMatch = c.req.header("If-None-Match");

  if (!(ifMatch || ifNoneMatch)) {
    return c.text("If-Match/If-None-Match header not provided", 428);
  }

  const existingFile = await store.getGroupAttachmentFile(groupID, itemKey);

  if (ifMatch) {
    if (!isValidMd5(ifMatch)) {
      return c.text("Invalid ETag in If-Match header", 400);
    }
    if (!existingFile) {
      return c.text("If-Match set but file does not exist", 412);
    }
    if (existingFile.md5 !== ifMatch) {
      return c.text("ETag does not match current version of file", 412);
    }
  } else if (ifNoneMatch !== "*") {
    return c.text("Invalid value for If-None-Match header", 400);
  } else if (existingFile) {
    return c.text("If-None-Match: * set but file exists", 412);
  }

  const uploadKey = params.get("upload");
  if (uploadKey !== null) {
    if (!uploadKey) {
      return c.text("Upload key not provided", 400);
    }

    const result = await store.registerGroupAttachmentUpload(
      groupID,
      itemKey,
      uploadKey
    );

    if (!result.found) {
      return c.text("Upload key not found", 400);
    }
    if (!result.registered) {
      return c.text("Remote file not found", 400);
    }

    return c.body(null, 204, {
      "Last-Modified-Version": `${result.version}`,
    });
  }

  const md5 = params.get("md5") ?? "";
  const filename = params.get("filename") ?? "";
  const filesize = params.get("filesize") ?? "";
  const mtime = params.get("mtime") ?? "";

  if (!md5) {
    return c.text("MD5 hash not provided", 400);
  }
  if (!isValidMd5(md5)) {
    return c.text("Invalid MD5 hash", 400);
  }
  const zipMd5 = params.get("zipMD5");
  const zipFilename = params.get("zipFilename");
  if (zipMd5 && !isValidMd5(zipMd5)) {
    return c.text("Invalid ZIP MD5 hash", 400);
  }
  if (zipMd5 && !zipFilename) {
    return c.text("ZIP filename not provided", 400);
  }
  if (zipFilename && !zipMd5) {
    return c.text("ZIP MD5 hash not provided", 400);
  }
  if (!filename) {
    return c.text("Filename not provided", 400);
  }
  if (!mtime) {
    return c.text("File modification time not provided", 400);
  }
  if (!filesize) {
    return c.text("File size not provided", 400);
  }

  const sizeBytes = Number.parseInt(filesize, 10);
  if (!Number.isFinite(sizeBytes)) {
    return c.text("Invalid file size", 400);
  }

  if (existingFile && existingFile.md5 === md5) {
    return c.json({ exists: 1 }, 200, {
      "Last-Modified-Version": `${existingFile.version ?? 0}`,
    });
  }

  const quotaUserID = await store.getGroupOwnerUserID(groupID);
  if (quotaUserID === null) {
    return c.text("Group not found", 404);
  }
  const quotaError = await checkStorageQuota(c, store, quotaUserID, sizeBytes);
  if (quotaError) {
    return quotaError;
  }

  const authorization = await store.authorizeGroupAttachmentUpload(
    groupID,
    itemKey,
    {
      charset: params.get("charset"),
      contentType: params.get("contentType"),
      filename: zipFilename ?? filename,
      itemFilename: zipFilename ? filename : null,
      itemMd5: zipMd5 ? md5 : null,
      md5: zipMd5 ?? md5,
      mtime: Number.parseInt(mtime, 10),
      sizeBytes,
      zip: params.get("zip") === "1" || Boolean(zipMd5),
    },
    getGroupUploadBaseURL(c, groupID, itemKey)
  );

  if (params.get("params") === "1") {
    return c.json({
      params: {},
      uploadKey: authorization.uploadKey,
      url: authorization.url,
    });
  }

  return c.json(authorization);
});


compatibility.post(
  "/users/:userID/items/:itemKey/file/upload/:uploadKey",
  async (c) => {
    const userID = parseNumericID(c.req.param("userID"));
    if (userID === null) {
      return c.text("Invalid userID", 400);
    }

    const body = await parseUploadBody(c.req.raw);
    const result = await createCompatibilityStore(c.env).storeAttachmentUpload(
      c.req.param("uploadKey"),
      body,
      c.req.header("Content-Type")
    );

    if (!result.found) {
      return c.text("Upload key not found", 400);
    }
    if (result.hashMismatch) {
      return c.text(
        "The Content-MD5 you specified did not match what we received",
        400
      );
    }
    if (result.sizeMismatch) {
      return c.text(
        "Your proposed upload exceeds the maximum allowed size",
        400
      );
    }

    return c.body(null, 201);
  }
);


compatibility.get(
  "/users/:userID/publications/items/:itemKey/file/raw/:md5/:filename",
  async (c) => {
    const userID = parseNumericID(c.req.param("userID"));
    if (userID === null) {
      return c.text("Invalid userID", 400);
    }

    const store = createCompatibilityStore(c.env);
    const publication = await getPublicationItem(
      store,
      userID,
      c.req.param("itemKey")
    );
    if (!publication) {
      return c.text("Item not found", 404);
    }

    const result = await store.getAttachmentObject(userID, c.req.param("itemKey"));

    if (!(await requireSignedRawFileURL(c))) {
      return c.text("Invalid file URL", 403);
    }

    if (!result || result.file.md5 !== c.req.param("md5")) {
      return c.text("File not found", 404);
    }

    return c.body(result.body, 200, {
      "Content-Disposition": `inline; filename="${result.file.filename}"`,
      "Content-Type": formatAttachmentContentType(result.file),
    });
  }
);


compatibility.get(
  "/users/:userID/publications/items/:itemKey/file/view/url",
  async (c) => {
    const userID = parseNumericID(c.req.param("userID"));
    if (userID === null) {
      return c.text("Invalid userID", 400);
    }

    const store = createCompatibilityStore(c.env);
    const publication = await getPublicationItem(
      store,
      userID,
      c.req.param("itemKey")
    );
    if (!publication) {
      return c.text("Item not found", 404);
    }

    const file = await store.getAttachmentFile(userID, c.req.param("itemKey"));
    if (!file) {
      return c.text("File not found", 404);
    }

    return c.text(
      await getPublicationRawFileURL(
        c,
        userID,
        c.req.param("itemKey"),
        file.md5,
        file.filename
      )
    );
  }
);


compatibility.get(
  "/users/:userID/publications/items/:itemKey/file/view",
  async (c) => {
    const userID = parseNumericID(c.req.param("userID"));
    if (userID === null) {
      return c.text("Invalid userID", 400);
    }

    const store = createCompatibilityStore(c.env);
    const publication = await getPublicationItem(
      store,
      userID,
      c.req.param("itemKey")
    );
    if (!publication) {
      return c.text("Item not found", 404);
    }

    const file = await store.getAttachmentFile(userID, c.req.param("itemKey"));
    if (!file) {
      return c.text("File not found", 404);
    }

    return c.redirect(
      await getPublicationRawFileURL(
        c,
        userID,
        c.req.param("itemKey"),
        file.md5,
        file.filename
      ),
      302
    );
  }
);


compatibility.get("/users/:userID/publications/items/:itemKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  const publication = await getPublicationItem(
    store,
    userID,
    c.req.param("itemKey")
  );
  if (!publication) {
    return c.text("Item not found", 404);
  }

  if (c.req.query("format") === "atom") {
    return c.text(
      renderPublicationItemAtom(c, userID, c.req.param("itemKey")),
      200,
      {
        "Content-Type": "application/atom+xml",
        "Last-Modified-Version": `${publication.version}`,
      }
    );
  }

  return c.json(
    withPublicationLinks(c, userID, publication.item),
    200,
    {
      "Last-Modified-Version": `${publication.version}`,
    }
  );
});


compatibility.get("/users/:userID/publications/items", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const result = await createCompatibilityStore(c.env).listItems(userID);
  const items = result.items.filter((item) => item.data.inPublications === true);

  if (c.req.query("format") === "atom") {
    return c.text(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<feed xmlns="http://www.w3.org/2005/Atom">',
        ...items.map((item) =>
          renderPublicationItemAtom(c, userID, item.key)
        ),
        "</feed>",
      ].join(""),
      200,
      {
        "Content-Type": "application/atom+xml",
        "Last-Modified-Version": `${result.version}`,
        "Total-Results": `${items.length}`,
      }
    );
  }

  return c.json(items.map((item) => withPublicationLinks(c, userID, item)), 200, {
    "Last-Modified-Version": `${result.version}`,
    "Total-Results": `${items.length}`,
  });
});


compatibility.get(
  "/users/:userID/items/:itemKey/file/raw/:md5/:filename",
  async (c) => {
    const userID = parseNumericID(c.req.param("userID"));
    if (userID === null) {
      return c.text("Invalid userID", 400);
    }

    const result = await createCompatibilityStore(c.env).getAttachmentObject(
      userID,
      c.req.param("itemKey")
    );

    if (!(await requireSignedRawFileURL(c))) {
      return c.text("Invalid file URL", 403);
    }

    if (!result || result.file.md5 !== c.req.param("md5")) {
      return c.text("File not found", 404);
    }

    return c.body(result.body, 200, {
      "Content-Disposition": `inline; filename="${result.file.filename}"`,
      "Content-Type": formatAttachmentContentType(result.file),
    });
  }
);


compatibility.get("/users/:userID/items/:itemKey/file/view/url", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const file = await store.getAttachmentFile(userID, c.req.param("itemKey"));
  if (!file) {
    return c.text("File not found", 404);
  }

  return c.text(
    await getRawFileURL(c, userID, c.req.param("itemKey"), file.md5, file.filename)
  );
});


compatibility.get("/users/:userID/items/:itemKey/file/view", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const file = await store.getAttachmentFile(userID, c.req.param("itemKey"));
  if (!file) {
    return c.text("File not found", 404);
  }

  return c.redirect(
    await getRawFileURL(c, userID, c.req.param("itemKey"), file.md5, file.filename),
    302
  );
});


compatibility.get("/users/:userID/items/:itemKey/file", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const file = await store.getAttachmentFile(userID, c.req.param("itemKey"));
  if (!file) {
    return c.text("File not found", 404);
  }

  return c.redirect(
    await getRawFileURL(c, userID, c.req.param("itemKey"), file.md5, file.filename),
    302
  );
});


compatibility.patch("/users/:userID/items/:itemKey/file", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const itemKey = c.req.param("itemKey");
  if (!(await store.getItem(userID, itemKey))) {
    return c.text("Item not found", 404);
  }

  const uploadKey = c.req.query("upload");
  if (!uploadKey) {
    return c.text("Upload key not provided", 400);
  }

  const algorithm = c.req.query("algorithm");
  if (!algorithm) {
    return c.text("Algorithm not specified", 400);
  }
  if (!supportedPartialUploadAlgorithms.has(algorithm)) {
    return c.text(`Invalid algorithm '${algorithm}'`, 400);
  }

  const ifMatch = c.req.header("If-Match")?.replaceAll('"', "");
  if (!ifMatch) {
    return c.text("If-Match/If-None-Match header not provided", 428);
  }
  if (!isValidMd5(ifMatch)) {
    return c.text("Invalid ETag in If-Match header", 400);
  }

  const existingFile = await store.getAttachmentFile(userID, itemKey);
  if (!existingFile) {
    return c.text("If-Match set but file does not exist", 412);
  }
  if (existingFile.md5 !== ifMatch) {
    return c.text("ETag does not match current version of file", 412);
  }

  const original = await store.getAttachmentObject(userID, itemKey);
  if (!original) {
    return c.text("File not found", 404);
  }

  let patched: ArrayBuffer;
  try {
    patched = await applyZoteroPatch(
      algorithm,
      await responseBodyToArrayBuffer(original.body),
      await c.req.raw.arrayBuffer()
    );
  } catch (error) {
    if (error instanceof PatchAlgorithmUnavailableError) {
      return c.text(
        "Partial upload patch engine is not available in the Worker runtime yet",
        501
      );
    }

    return c.text("Error applying patch", 400);
  }

  const uploadResult = await store.storeAttachmentUpload(uploadKey, patched);
  if (!uploadResult.found) {
    return c.text("Upload key not found", 400);
  }
  if (uploadResult.hashMismatch) {
    return c.text("Patched file does not match hash", 409);
  }
  if (uploadResult.sizeMismatch) {
    return c.text("Patched file size does not match", 409);
  }

  const result = await store.registerAttachmentUpload(userID, itemKey, uploadKey);
  if (!result.registered) {
    return c.text("Upload key not found", 400);
  }

  return c.body(null, 204, {
    "Last-Modified-Version": `${result.version}`,
  });
});


compatibility.post("/users/:userID/items/:itemKey/file", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const itemKey = c.req.param("itemKey");
  if (!(await store.getItem(userID, itemKey))) {
    return c.text("Item not found", 404);
  }

  const params = await parseFileParams(c);
  const ifMatch = c.req.header("If-Match")?.replaceAll('"', "");
  const ifNoneMatch = c.req.header("If-None-Match");

  if (!(ifMatch || ifNoneMatch)) {
    return c.text("If-Match/If-None-Match header not provided", 428);
  }

  const existingFile = await store.getAttachmentFile(userID, itemKey);

  if (ifMatch) {
    if (!isValidMd5(ifMatch)) {
      return c.text("Invalid ETag in If-Match header", 400);
    }
    if (!existingFile) {
      return c.text("If-Match set but file does not exist", 412);
    }
    if (existingFile.md5 !== ifMatch) {
      return c.text("ETag does not match current version of file", 412);
    }
  } else if (ifNoneMatch !== "*") {
    return c.text("Invalid value for If-None-Match header", 400);
  } else if (existingFile) {
    return c.text("If-None-Match: * set but file exists", 412);
  }

  const uploadKey = params.get("upload");
  if (uploadKey !== null) {
    if (!uploadKey) {
      return c.text("Upload key not provided", 400);
    }

    const result = await store.registerAttachmentUpload(
      userID,
      itemKey,
      uploadKey
    );

    if (!result.found) {
      return c.text("Upload key not found", 400);
    }
    if (!result.registered) {
      return c.text("Remote file not found", 400);
    }

    return c.body(null, 204, {
      "Last-Modified-Version": `${result.version}`,
    });
  }

  const md5 = params.get("md5") ?? "";
  const filename = params.get("filename") ?? "";
  const filesize = params.get("filesize") ?? "";
  const mtime = params.get("mtime") ?? "";

  if (!md5) {
    return c.text("MD5 hash not provided", 400);
  }
  if (!isValidMd5(md5)) {
    return c.text("Invalid MD5 hash", 400);
  }
  const zipMd5 = params.get("zipMD5");
  const zipFilename = params.get("zipFilename");
  if (zipMd5 && !isValidMd5(zipMd5)) {
    return c.text("Invalid ZIP MD5 hash", 400);
  }
  if (zipMd5 && !zipFilename) {
    return c.text("ZIP filename not provided", 400);
  }
  if (zipFilename && !zipMd5) {
    return c.text("ZIP MD5 hash not provided", 400);
  }
  if (!filename) {
    return c.text("Filename not provided", 400);
  }
  if (!mtime) {
    return c.text("File modification time not provided", 400);
  }
  if (!filesize) {
    return c.text("File size not provided", 400);
  }

  const sizeBytes = Number.parseInt(filesize, 10);
  if (!Number.isFinite(sizeBytes)) {
    return c.text("Invalid file size", 400);
  }

  if (existingFile && existingFile.md5 === md5) {
    return c.json({ exists: 1 }, 200, {
      "Last-Modified-Version": `${existingFile.version ?? 0}`,
    });
  }

  const quotaError = await checkStorageQuota(c, store, userID, sizeBytes);
  if (quotaError) {
    return quotaError;
  }

  const authorization = await store.authorizeAttachmentUpload(
    userID,
    itemKey,
    {
      charset: params.get("charset"),
      contentType: params.get("contentType"),
      filename: zipFilename ?? filename,
      itemFilename: zipFilename ? filename : null,
      itemMd5: zipMd5 ? md5 : null,
      md5: zipMd5 ?? md5,
      mtime: Number.parseInt(mtime, 10),
      sizeBytes,
      zip: params.get("zip") === "1" || Boolean(zipMd5),
    },
    getUploadBaseURL(c, userID, itemKey)
  );

  if (params.get("params") === "1") {
    return c.json({
      params: {},
      uploadKey: authorization.uploadKey,
      url: authorization.url,
    });
  }

  return c.json(authorization);
});
