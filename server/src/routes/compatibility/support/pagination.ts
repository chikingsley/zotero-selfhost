import type { Context } from "hono";
import type { Bindings } from "../../../bindings";

type CompatibilityContext = Context<{ Bindings: Bindings }>;

export const paginateRecords = <T>(
  c: CompatibilityContext,
  records: T[]
): { headers: Record<string, string>; records: T[]; total: number } => {
  const total = records.length;
  const start = parseNonNegativeInteger(c.req.query("start")) ?? 0;
  const limit = parsePositiveInteger(c.req.query("limit"));
  const paginated =
    limit === null ? records : records.slice(start, start + limit);
  const headers: Record<string, string> = {
    "Total-Results": `${total}`,
  };

  if (limit !== null) {
    const links: string[] = [];
    const buildPageURL = (nextStart: number) => {
      const url = new URL(c.req.url);
      if (nextStart <= 0) {
        url.searchParams.delete("start");
      } else {
        url.searchParams.set("start", `${nextStart}`);
      }
      url.searchParams.set("limit", `${limit}`);
      return url.toString();
    };
    const lastStart = Math.max(0, total - (total % limit || limit));

    if (start > 0) {
      links.push(`<${buildPageURL(0)}>; rel="first"`);
      links.push(`<${buildPageURL(Math.max(0, start - limit))}>; rel="prev"`);
    }
    if (start + limit < total) {
      links.push(`<${buildPageURL(start + limit)}>; rel="next"`);
    }
    if (total > limit && start !== lastStart) {
      links.push(`<${buildPageURL(lastStart)}>; rel="last"`);
    }
    if (links.length) {
      headers.Link = links.join(", ");
    }
  }

  return {
    headers,
    records: paginated,
    total,
  };
};

export const parseNonNegativeInteger = (
  value: string | undefined
): number | null => {
  if (value === undefined) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

export const parsePositiveInteger = (
  value: string | undefined
): number | null => {
  if (value === undefined) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
