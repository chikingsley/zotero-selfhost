import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import { parseSettingsRequestBody } from "../../../domain/settings";
import { requestIsNotModified } from "./request-versions";

export const settingHeaders = (version: number) => ({
  "Last-Modified-Version": `${version}`,
});

export const renderSettingsList = (
  c: Context<{ Bindings: Bindings }>,
  result: { settings: Record<string, unknown>; version: number }
) => {
  if (requestIsNotModified(c, result.version)) {
    return c.body(null, 304, settingHeaders(result.version));
  }

  return c.json(result.settings, 200, settingHeaders(result.version));
};

export const getRequestedSettingKeys = (c: Context<{ Bindings: Bindings }>) =>
  (c.req.query("settingKey") ?? "")
    .split(",")
    .map((settingKey) => settingKey.trim())
    .filter(Boolean);

export const isSettingsObject = (
  value: unknown
): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseSettingsBody = async (c: Context<{ Bindings: Bindings }>) =>
  parseSettingsRequestBody(await c.req.text());

export const renderSettingsWriteFailure = (
  c: Context<{ Bindings: Bindings }>,
  failure: { code: number; message: string }
) => c.text(failure.message, failure.code as 400 | 403 | 412 | 413);

export const ensureSingleSettingPrecondition = (
  existing: { setting: { version: number } } | null,
  ifUnmodifiedSinceVersion: number | null
) => {
  if (ifUnmodifiedSinceVersion === null) {
    return false;
  }

  return existing
    ? existing.setting.version > ifUnmodifiedSinceVersion
    : ifUnmodifiedSinceVersion > 0;
};
