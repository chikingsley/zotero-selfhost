import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import { paginateRecords } from "./pagination";
import { requestIsNotModified } from "./request-versions";
import {
  isHeadRequest,
  renderJSONAtomEntry,
  renderJSONAtomFeed,
  wantsAtomResponse,
} from "./responses";
import { sortRecordsForRequest } from "./sorting";

export const renderTagList = (
  c: Context<{ Bindings: Bindings }>,
  tags: Array<{ tag: string }>,
  version: number
) => {
  if (requestIsNotModified(c, version)) {
    return c.body(null, 304, {
      "Last-Modified-Version": `${version}`,
    });
  }

  const sortedTags = sortRecordsForRequest(c, tags, (tag) => tag.tag);
  const page = paginateRecords(c, sortedTags);

  if (isHeadRequest(c)) {
    return c.body(null, 200, {
      "Last-Modified-Version": `${version}`,
      ...page.headers,
    });
  }

  if (wantsAtomResponse(c)) {
    return c.text(
      renderJSONAtomFeed(
        "Tags",
        page.records.map((tag) =>
          renderJSONAtomEntry({
            content: tag,
            id: `tags/${tag.tag}`,
            key: tag.tag,
            title: tag.tag,
            version,
          })
        )
      ),
      200,
      {
        "Content-Type": "application/atom+xml",
        "Last-Modified-Version": `${version}`,
        ...page.headers,
      }
    );
  }

  return c.json(page.records, 200, {
    "Last-Modified-Version": `${version}`,
    ...page.headers,
  });
};
