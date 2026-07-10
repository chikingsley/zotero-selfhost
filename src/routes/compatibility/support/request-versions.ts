import type { Context } from "hono";
import type { Bindings } from "../../../bindings";

export const getIfUnmodifiedSinceVersion = (
  c: Context<{ Bindings: Bindings }>
): number | null => {
  const value = c.req.header("If-Unmodified-Since-Version");
  if (!value) {
    return null;
  }

  const version = Number.parseInt(value, 10);
  return Number.isFinite(version) ? version : null;
};

export const getSinceOrNewerVersion = (
  c: Context<{ Bindings: Bindings }>
): number | null => {
  const value = c.req.query("since") ?? c.req.query("newer");
  if (!value) {
    return null;
  }

  const version = Number.parseInt(value, 10);
  return Number.isFinite(version) ? version : null;
};

export const getSinceVersion = (
  c: Context<{ Bindings: Bindings }>
): number | null => {
  const value = c.req.query("since");
  if (!value) {
    return null;
  }

  const version = Number.parseInt(value, 10);
  return Number.isFinite(version) ? version : null;
};

export const getSearchSinceVersion = getSinceOrNewerVersion;

export const getIfModifiedSinceVersion = (
  c: Context<{ Bindings: Bindings }>
): number | null => {
  const value = c.req.header("If-Modified-Since-Version");
  if (!value) {
    return null;
  }

  const version = Number.parseInt(value, 10);
  return Number.isFinite(version) ? version : null;
};

export const requestIsNotModified = (
  c: Context<{ Bindings: Bindings }>,
  version: number
): boolean => {
  const ifModifiedSinceVersion = getIfModifiedSinceVersion(c);
  return ifModifiedSinceVersion !== null && version <= ifModifiedSinceVersion;
};

export const getSchemaVersion = (
  c: Context<{ Bindings: Bindings }>
): number | null => {
  const value =
    c.req.header("Zotero-Schema-Version") ?? c.req.query("schemaVersion");
  if (!value) {
    return null;
  }

  const version = Number.parseInt(value, 10);
  return Number.isFinite(version) ? version : null;
};

export const getRequiredSinceVersion = getSinceVersion;
