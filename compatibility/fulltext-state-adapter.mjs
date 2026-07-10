const config = JSON.parse(process.env.NODE_CONFIG ?? "{}");

const request = async (method, libraryID, body) => {
  const url = new URL("test/fulltext-state", config.apiURLPrefix);
  url.searchParams.set("libraryID", String(libraryID));

  const response = await fetch(url, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.rootUsername}:${config.rootPassword}`).toString("base64")}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    method,
  });

  if (!response.ok) {
    throw new Error(
      `Full-text state API returned ${response.status}: ${await response.text()}`
    );
  }

  return response.json();
};

const getState = (libraryID) => request("GET", libraryID);
const setState = (libraryID, patch) => request("POST", libraryID, patch);

export const setFullTextDeindexed = (libraryID, deindexed) =>
  setState(libraryID, { deindexed });

export const getFullTextDeindexed = async (libraryID) =>
  (await getState(libraryID)).deindexed === true;

export const setFullTextReindexing = (libraryID, reindexing) =>
  setState(libraryID, { reindexing: reindexing || null });

export const getFullTextReindexing = async (libraryID) =>
  (await getState(libraryID)).reindexing ?? null;
