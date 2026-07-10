const defaultRetryStatuses = new Set([429, 500, 502, 503, 504]);

export class HTTPResponseError extends Error {
  constructor(message, { body, response }) {
    super(message);
    this.name = "HTTPResponseError";
    this.body = body;
    this.response = response;
    this.status = response.status;
  }
}

export class ZoteroAPIClient {
  constructor({ apiKey, baseURL, fetchImpl = globalThis.fetch }) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required.");
    }

    this.apiKey = apiKey;
    this.baseURL = normalizeOrigin(baseURL);
    this.fetchImpl = fetchImpl;
    this.notBefore = 0;
  }

  async request(path, init = {}) {
    const url = path instanceof URL ? path : new URL(path, this.baseURL);
    const headers = new Headers(init.headers);
    headers.set("Accept", headers.get("Accept") ?? "application/json");
    headers.set("Zotero-API-Version", "3");
    if (this.apiKey) {
      headers.set("Zotero-API-Key", this.apiKey);
    }

    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await this.waitForBackoff();

      let response;
      try {
        response = await this.fetchImpl(url, { ...init, headers });
      } catch (error) {
        lastError = error;
        if (attempt === 4) {
          break;
        }
        await sleep(250 * 2 ** attempt);
        continue;
      }

      this.captureBackoff(response);
      if (!defaultRetryStatuses.has(response.status) || attempt === 4) {
        return response;
      }

      await sleep(retryDelayMilliseconds(response, attempt));
    }

    throw new Error(
      `Could not reach ${url.origin}: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      { cause: lastError }
    );
  }

  async json(path, init = {}, acceptedStatuses = [200]) {
    const response = await this.request(path, init);
    const text = await response.text();
    const body = parsePossibleJSON(text);
    if (!acceptedStatuses.includes(response.status)) {
      throw new HTTPResponseError(
        `Request failed (HTTP ${response.status}) for ${response.url || new URL(path, this.baseURL)}`,
        { body, response }
      );
    }
    return { body, response };
  }

  captureBackoff(response) {
    const seconds = Math.max(
      parseSeconds(response.headers.get("Backoff")),
      defaultRetryStatuses.has(response.status)
        ? parseSeconds(response.headers.get("Retry-After"))
        : 0
    );
    if (seconds > 0) {
      this.notBefore = Math.max(this.notBefore, Date.now() + seconds * 1000);
    }
  }

  async waitForBackoff() {
    let remaining = this.notBefore - Date.now();
    while (remaining > 0) {
      await sleep(Math.min(remaining, 30_000));
      remaining = this.notBefore - Date.now();
    }
  }
}

export const normalizeOrigin = (value) => {
  const url = value instanceof URL ? new URL(value) : new URL(String(value));
  if (
    !(
      url.protocol === "https:" ||
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1"
    )
  ) {
    throw new Error(
      "API URLs must use HTTPS (localhost is allowed for testing)."
    );
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
};

export const parsePossibleJSON = (text) => {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(
      text.replace(/(:\s*)(-?\d{16,})(?=\s*[,}\]])/gu, '$1"$2"')
    );
  } catch {
    return text;
  }
};

export const requireRecord = (value, label) => {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    throw new Error(`${label} did not return a JSON object.`);
  }
  return value;
};

export const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const retryDelayMilliseconds = (response, attempt) => {
  const retryAfter = parseSeconds(response.headers.get("Retry-After"));
  if (retryAfter > 0) {
    return Math.min(retryAfter * 1000, 30_000);
  }
  return Math.min(500 * 2 ** attempt, 8000);
};

const parseSeconds = (value) => {
  const seconds = Number.parseInt(value ?? "", 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
};
