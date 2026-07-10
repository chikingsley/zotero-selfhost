import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";

interface R2Object {
  etag: string;
  key: string;
  size: number;
}

interface VerifiedTokenEnvelope {
  result?: { id?: string };
  success?: boolean;
}

const [sourceBucket, destinationBucket] = process.argv.slice(2);
const accountID = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

if (!(sourceBucket && destinationBucket)) {
  throw new Error(
    "Usage: bun run copy:r2 <source-bucket> <destination-bucket> | bun run empty:r2-drill <restore-drill-bucket>"
  );
}
if (!(accountID && apiToken)) {
  throw new Error(
    "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required"
  );
}
if (sourceBucket !== "--empty" && sourceBucket === destinationBucket) {
  throw new Error("Source and destination buckets must be different");
}

const verifyResponse = await fetch(
  "https://api.cloudflare.com/client/v4/user/tokens/verify",
  { headers: { Authorization: `Bearer ${apiToken}` } }
);
const verifiedToken = (await verifyResponse.json()) as VerifiedTokenEnvelope;
if (!(verifyResponse.ok && verifiedToken.success && verifiedToken.result?.id)) {
  throw new Error(
    "Could not derive R2 credentials from the Cloudflare API token"
  );
}

const client = new AwsClient({
  accessKeyId: verifiedToken.result.id,
  region: "auto",
  secretAccessKey: createHash("sha256").update(apiToken).digest("hex"),
  service: "s3",
});
const endpoint = `https://${accountID}.r2.cloudflarestorage.com`;

const decodeXml = (value: string): string =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
const readTag = (xml: string, tag: string): string | undefined =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "u").exec(xml)?.[1];
const encodeKey = (key: string): string =>
  key.split("/").map(encodeURIComponent).join("/");

const listObjects = async (bucket: string): Promise<R2Object[]> => {
  const objects: R2Object[] = [];
  let continuationToken: string | undefined;
  do {
    const url = new URL(`/${bucket}`, endpoint);
    url.searchParams.set("encoding-type", "url");
    url.searchParams.set("list-type", "2");
    url.searchParams.set("max-keys", "1000");
    if (continuationToken) {
      url.searchParams.set("continuation-token", continuationToken);
    }
    const response = await client.fetch(url);
    const xml = await response.text();
    if (!response.ok) {
      throw new Error(`Could not list ${bucket} (${response.status}): ${xml}`);
    }
    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)) {
      const key = readTag(match[1], "Key");
      const size = readTag(match[1], "Size");
      const etag = readTag(match[1], "ETag");
      if (!(key && size && etag)) {
        throw new Error(
          `R2 returned an incomplete object listing for ${bucket}`
        );
      }
      objects.push({
        etag: decodeXml(etag).replaceAll('"', ""),
        key: decodeURIComponent(decodeXml(key)),
        size: Number(size),
      });
    }
    const truncated = readTag(xml, "IsTruncated") === "true";
    continuationToken = truncated
      ? decodeXml(readTag(xml, "NextContinuationToken") ?? "")
      : undefined;
    if (truncated && !continuationToken) {
      throw new Error(`R2 omitted the continuation token for ${bucket}`);
    }
  } while (continuationToken);
  return objects;
};

if (sourceBucket === "--empty") {
  if (!destinationBucket.includes("-restore-drill-")) {
    throw new Error("Refusing to empty a bucket not named as a restore drill");
  }
  const queue = await listObjects(destinationBucket);
  const objectCount = queue.length;
  await Promise.all(
    Array.from({ length: Math.min(10, queue.length) }, async () => {
      while (queue.length > 0) {
        const object = queue.shift();
        if (object) {
          const response = await client.fetch(
            `${endpoint}/${destinationBucket}/${encodeKey(object.key)}`,
            { method: "DELETE" }
          );
          if (!response.ok) {
            throw new Error(
              `Could not delete ${object.key} from ${destinationBucket} (${response.status})`
            );
          }
        }
      }
    })
  );
  const remaining = await listObjects(destinationBucket);
  if (remaining.length > 0) {
    throw new Error(
      `${destinationBucket} still contains ${remaining.length} objects`
    );
  }
  console.log(`Emptied ${destinationBucket}: ${objectCount} objects deleted`);
  process.exit(0);
}

const sourceObjects = await listObjects(sourceBucket);
const sourceBytes = sourceObjects.reduce(
  (total, object) => total + object.size,
  0
);
const existingDestinationObjects = await listObjects(destinationBucket);
const existingDestinationByKey = new Map(
  existingDestinationObjects.map((object) => [object.key, object])
);
const objectsToCopy = sourceObjects.filter((source) => {
  const destination = existingDestinationByKey.get(source.key);
  return !(
    destination &&
    destination.size === source.size &&
    (source.etag.includes("-") || destination.etag === source.etag)
  );
});
console.log(
  `Verifying ${sourceObjects.length} objects (${(sourceBytes / 1024 ** 3).toFixed(3)} GiB) from ${sourceBucket} to ${destinationBucket}; ${objectsToCopy.length} need copying...`
);

let copied = 0;
const copyObject = async (object: R2Object): Promise<void> => {
  const destinationURL = `${endpoint}/${destinationBucket}/${encodeKey(object.key)}`;
  const response = await client.fetch(destinationURL, {
    headers: {
      "x-amz-copy-source": `/${sourceBucket}/${encodeKey(object.key)}`,
    },
    method: "PUT",
  });
  const body = await response.text();
  if (!response.ok || body.includes("<Error>")) {
    throw new Error(
      `Could not copy ${object.key} (${response.status}): ${body}`
    );
  }
  copied += 1;
  if (copied % 25 === 0 || copied === objectsToCopy.length) {
    console.log(`Copied ${copied}/${objectsToCopy.length} objects`);
  }
};

const queue = [...objectsToCopy];
await Promise.all(
  Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length > 0) {
      const object = queue.shift();
      if (object) {
        await copyObject(object);
      }
    }
  })
);

const destinationObjects = await listObjects(destinationBucket);
const destinationByKey = new Map(
  destinationObjects.map((object) => [object.key, object])
);
for (const source of sourceObjects) {
  const destination = destinationByKey.get(source.key);
  if (
    !destination ||
    destination.size !== source.size ||
    (!source.etag.includes("-") && destination.etag !== source.etag)
  ) {
    throw new Error(`Verification failed for ${source.key}`);
  }
}
if (destinationObjects.length !== sourceObjects.length) {
  throw new Error(
    `Destination contains ${destinationObjects.length} objects; expected ${sourceObjects.length}`
  );
}

console.log(
  JSON.stringify(
    {
      bytes: sourceBytes,
      destinationBucket,
      objects: sourceObjects.length,
      sourceBucket,
      status: "verified",
    },
    null,
    2
  )
);
