import { exports } from "cloudflare:workers";

const testOrigin = "https://zotero.test";

export const runtimeRequest = (
  path: string,
  init?: RequestInit
): Promise<Response> =>
  exports.default.fetch(new Request(new URL(path, testOrigin), init));
