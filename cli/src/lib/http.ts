const defaultRetryStatuses = new Set([429, 500, 502, 503, 504]);

export class HTTPResponseError extends Error {
  readonly body: unknown;
  readonly response: Response;
  readonly status: number;

  constructor(
    message: string,
    { body, response }: { body: unknown; response: Response }
  ) {
    super(message);
    this.name = "HTTPResponseError";
    this.body = body;
    this.response = response;
    this.status = response.status;
  }
}

export class ZoteroAPIClient {
  readonly apiKey?: string;
  readonly baseURL: URL;
  readonly fetchImpl: typeof fetch;
  private notBefore = 0;

  constructor({
    apiKey,
    baseURL,
    fetchImpl = globalThis.fetch,
  }: {
    apiKey?: string;
    baseURL: string | URL;
    fetchImpl?: typeof fetch;
  }) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required.");
    }

    this.apiKey = apiKey;
    this.baseURL = normalizeOrigin(baseURL);
    this.fetchImpl = fetchImpl;
  }

  async request(path: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = path instanceof URL ? path : new URL(path, this.baseURL);
    const headers = new Headers(init.headers);
    headers.set("Accept", headers.get("Accept") ?? "application/json");
    headers.set("Zotero-API-Version", "3");
    if (this.apiKey) {
      headers.set("Zotero-API-Key", this.apiKey);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await this.waitForBackoff();

      let response: Response;
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

  async json(
    path: string | URL,
    init: RequestInit = {},
    acceptedStatuses = [200]
  ): Promise<{ body: unknown; response: Response }> {
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

  private captureBackoff(response: Response): void {
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

  private async waitForBackoff(): Promise<void> {
    let remaining = this.notBefore - Date.now();
    while (remaining > 0) {
      await sleep(Math.min(remaining, 30_000));
      remaining = this.notBefore - Date.now();
    }
  }
}

export const normalizeOrigin = (value: string | URL): URL => {
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

export const parsePossibleJSON = (text: string): unknown => {
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

export const requireRecord = (
  value: unknown,
  label: string
): Record<string, unknown> => {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    throw new Error(`${label} did not return a JSON object.`);
  }
  return value as Record<string, unknown>;
};

export const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const retryDelayMilliseconds = (
  response: Response,
  attempt: number
): number => {
  const retryAfter = parseSeconds(response.headers.get("Retry-After"));
  if (retryAfter > 0) {
    return Math.min(retryAfter * 1000, 30_000);
  }
  return Math.min(500 * 2 ** attempt, 8000);
};

const parseSeconds = (value: string | null): number => {
  const seconds = Number.parseInt(value ?? "", 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
};
