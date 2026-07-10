import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import { createFullTextStore } from "../../../domain/fulltext";
import {
  type CompatibilityStore,
  createCompatibilityStore,
} from "../../../domain/storage";
import { compatibility } from "../router";
import {
  attachItemMeta,
  attachItemsMeta,
  filterItemsForRequest,
  getIfUnmodifiedSinceVersion,
  getSinceOrNewerVersion,
  handleItemBatchWrite,
  hasJSONContentType,
  parseNumericID,
  renderItemList,
  renderItemListHead,
  renderSingleItem,
  requireGroup,
  requireGroupEdit,
  requireUser,
  requireUserWrite,
} from "../support";

type LibraryType = "group" | "user";
type CompatibilityContext = Context<{ Bindings: Bindings }>;

interface AuthorizedLibrary {
  libraryID: number;
  store: CompatibilityStore;
}

const getLibraryPath = (libraryType: LibraryType) =>
  libraryType === "user" ? "/users/:userID" : "/groups/:groupID";

const authorizeLibrary = async (
  c: CompatibilityContext,
  libraryType: LibraryType,
  write: boolean
): Promise<AuthorizedLibrary | Response> => {
  const parameterName = libraryType === "user" ? "userID" : "groupID";
  const libraryID = parseNumericID(c.req.param(parameterName) ?? "");
  if (libraryID === null) {
    return c.text(`Invalid ${parameterName}`, 400);
  }

  const store = createCompatibilityStore(c.env);
  const allowed =
    libraryType === "user"
      ? write
        ? await requireUserWrite(c, store, libraryID)
        : await requireUser(c, store, libraryID)
      : write
        ? await requireGroupEdit(c, store, libraryID)
        : await requireGroup(c, store, libraryID);
  return allowed ? { libraryID, store } : c.text("Invalid key", 403);
};

const getItem = (
  target: AuthorizedLibrary,
  libraryType: LibraryType,
  itemKey: string
) =>
  libraryType === "user"
    ? target.store.getItem(target.libraryID, itemKey)
    : target.store.getGroupItem(target.libraryID, itemKey);

const listItems = (
  target: AuthorizedLibrary,
  libraryType: LibraryType,
  itemKeys?: string[]
) =>
  libraryType === "user"
    ? target.store.listItems(target.libraryID, itemKeys)
    : target.store.listGroupItems(target.libraryID, itemKeys);

const getGroupName = async (
  target: AuthorizedLibrary,
  libraryType: LibraryType
): Promise<string | undefined> => {
  if (libraryType === "user") {
    return;
  }

  const group = (await target.store.listGroups()).find(
    (candidate) => candidate.id === target.libraryID
  );
  return typeof group?.data.name === "string" ? group.data.name : undefined;
};

export const registerItemRoutes = (libraryType: LibraryType): void => {
  const basePath = getLibraryPath(libraryType);

  compatibility.get(`${basePath}/items/:itemKey`, async (c) => {
    const target = await authorizeLibrary(c, libraryType, false);
    if (target instanceof Response) {
      return target;
    }

    const result = await getItem(target, libraryType, c.req.param("itemKey"));
    const item = result?.items[0];
    if (!(result && item)) {
      return c.text("Item not found", 404);
    }

    const library = await listItems(target, libraryType);
    return renderSingleItem(
      c,
      await attachItemMeta(c, item, {
        allItems: library.items,
        groupName: await getGroupName(target, libraryType),
        libraryID: target.libraryID,
        libraryType,
        store: target.store,
      }),
      result.version
    );
  });

  compatibility.get(`${basePath}/items/:itemKey/fulltext`, async (c) => {
    const target = await authorizeLibrary(c, libraryType, false);
    if (target instanceof Response) {
      return target;
    }

    const record = await createFullTextStore(c.env).getContent(
      libraryType,
      target.libraryID,
      c.req.param("itemKey")
    );
    if (!record) {
      return c.text("Full-text content not found", 404);
    }

    const { itemKey: _itemKey, version, ...body } = record;
    return c.json(body, 200, {
      "Last-Modified-Version": `${version}`,
    });
  });

  compatibility.put(`${basePath}/items/:itemKey/fulltext`, async (c) => {
    const target = await authorizeLibrary(c, libraryType, true);
    if (target instanceof Response) {
      return target;
    }
    if (!hasJSONContentType(c)) {
      return c.text("Content-Type must be application/json", 400);
    }

    const body = await c.req.json().catch(() => null);
    const result = await createFullTextStore(c.env).upsertContent(
      libraryType,
      target.libraryID,
      c.req.param("itemKey"),
      body
    );
    if (result.missingItem) {
      return c.text("Item not found", 404);
    }
    if (!result.record) {
      return c.text("Invalid full-text content", 400);
    }

    return c.body(null, 204, {
      "Last-Modified-Version": `${result.version}`,
    });
  });

  compatibility.get(`${basePath}/fulltext/index`, async (c) => {
    const target = await authorizeLibrary(c, libraryType, false);
    if (target instanceof Response) {
      return target;
    }

    return c.json(
      await createFullTextStore(c.env).getIndexStatus(
        libraryType,
        target.libraryID
      )
    );
  });

  compatibility.get(`${basePath}/fulltext`, async (c) => {
    const target = await authorizeLibrary(c, libraryType, false);
    if (target instanceof Response) {
      return target;
    }

    const result = await createFullTextStore(c.env).listVersions(
      libraryType,
      target.libraryID,
      getSinceOrNewerVersion(c)
    );

    return c.json(result.versions, 200, {
      "Last-Modified-Version": `${result.version}`,
    });
  });

  compatibility.post(`${basePath}/fulltext`, async (c) => {
    const target = await authorizeLibrary(c, libraryType, true);
    if (target instanceof Response) {
      return target;
    }
    if (!hasJSONContentType(c)) {
      return c.text("Content-Type must be application/json", 400);
    }
    const preconditionVersion = getIfUnmodifiedSinceVersion(c);
    if (preconditionVersion === null) {
      return c.text("If-Unmodified-Since-Version not provided", 428);
    }

    const body = await c.req.json().catch(() => null);
    if (!Array.isArray(body)) {
      return c.text("Expected a full-text content array", 400);
    }

    const result = await createFullTextStore(c.env).upsertContentBatch(
      libraryType,
      target.libraryID,
      body,
      preconditionVersion
    );
    if (result.preconditionFailed) {
      return c.text("Library has been modified", 412, {
        "Last-Modified-Version": `${result.version}`,
      });
    }

    return c.json(
      {
        failed: result.failed,
        success: result.success,
        successful: Object.fromEntries(
          Object.entries(result.successful).map(([index, record]) => [
            index,
            { ...record, key: record.itemKey },
          ])
        ),
        unchanged: {},
      },
      200,
      {
        "Last-Modified-Version": `${result.version}`,
      }
    );
  });

  compatibility.on("HEAD", `${basePath}/items`, async (c) => {
    const target = await authorizeLibrary(c, libraryType, false);
    if (target instanceof Response) {
      return target;
    }

    const itemKeys = c.req.query("itemKey")?.split(",");
    const result = await listItems(target, libraryType, itemKeys);
    const items = await filterItemsForRequest(
      c,
      libraryType,
      target.libraryID,
      result.items
    );

    return renderItemListHead(c, items, result.version);
  });

  compatibility.get(`${basePath}/items`, async (c) => {
    const target = await authorizeLibrary(c, libraryType, false);
    if (target instanceof Response) {
      return target;
    }

    const itemKeys = c.req.query("itemKey")?.split(",");
    const result = await listItems(target, libraryType, itemKeys);
    const includeTrashed = c.req.query("includeTrashed") === "1";
    const visible = includeTrashed
      ? result.items
      : result.items.filter((item) => !item.data?.deleted);
    const items = await filterItemsForRequest(
      c,
      libraryType,
      target.libraryID,
      visible
    );

    return renderItemList(
      c,
      await attachItemsMeta(c, items, {
        allItems: result.items,
        groupName: await getGroupName(target, libraryType),
        libraryID: target.libraryID,
        libraryType,
        store: target.store,
      }),
      result.version
    );
  });

  compatibility.post(`${basePath}/items`, async (c) => {
    const target = await authorizeLibrary(c, libraryType, true);
    if (target instanceof Response) {
      return target;
    }

    return handleItemBatchWrite(c, {
      libraryID: target.libraryID,
      libraryType,
      store: target.store,
    });
  });
};
