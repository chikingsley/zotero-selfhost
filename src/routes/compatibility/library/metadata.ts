import {
  getCreatorFields,
  getItemFields,
  getItemTypeCreatorTypes,
  getItemTypeFields,
  getItemTypes,
  validItemTypes,
} from "../../../domain/mappings";
import {
  getItemTemplate,
  isSupportedAnnotationType,
  isSupportedAttachmentLinkMode,
} from "../../../domain/zotero";
import { compatibility } from "../router";

compatibility.get("/itemTypes", (c) =>
  c.json(getItemTypes(c.req.query("locale") ?? "en-US"))
);

compatibility.get("/itemFields", (c) => c.json(getItemFields()));

compatibility.get("/itemTypeFields", (c) => {
  const itemType = c.req.query("itemType");
  if (!itemType) {
    return c.text("'itemType' not provided", 400);
  }

  const fields = getItemTypeFields(itemType);
  if (!fields || itemType === "annotation") {
    return c.text(`Invalid item type '${itemType}'`, 400);
  }

  return c.json(fields);
});

compatibility.get("/itemTypeCreatorTypes", (c) => {
  const itemType = c.req.query("itemType");
  if (!itemType) {
    return c.text("'itemType' not provided", 400);
  }
  if (!validItemTypes.has(itemType) || itemType === "annotation") {
    return c.text(`Invalid item type '${itemType}'`, 400);
  }

  return c.json(getItemTypeCreatorTypes(itemType));
});

compatibility.get("/creatorFields", (c) => c.json(getCreatorFields()));

compatibility.get("/items/new", (c) => {
  const itemType = c.req.query("itemType");
  if (!itemType) {
    return c.text("'itemType' not provided", 400);
  }

  if (itemType !== "annotation" && !validItemTypes.has(itemType)) {
    return c.text(`Invalid item type '${itemType}'`, 400);
  }

  const linkMode = c.req.query("linkMode");
  if (itemType === "attachment") {
    if (!linkMode) {
      return c.text("linkMode required for itemType=attachment", 400);
    }
    if (!isSupportedAttachmentLinkMode(linkMode)) {
      return c.text(`Invalid linkMode '${linkMode}'`, 400);
    }
  }

  const annotationType = c.req.query("annotationType");
  if (itemType === "annotation") {
    if (!annotationType) {
      return c.text("annotationType required for itemType=annotation", 400);
    }
    if (!isSupportedAnnotationType(annotationType)) {
      return c.text(`Invalid annotationType '${annotationType}'`, 400);
    }
  }

  return c.json(getItemTemplate(itemType, linkMode, annotationType));
});
