import { AwsClient } from "aws4fetch";
import type { Bindings } from "../bindings";

const presignedUrlTtlSeconds = 15 * 60;

interface SigningConfig {
  accessKeyId: string;
  accountId: string;
  bucketName: string;
  secretAccessKey: string;
}

export const hasR2SigningConfig = (env: Bindings): boolean =>
  Boolean(
    env.R2_ACCOUNT_ID &&
      env.R2_ACCESS_KEY_ID &&
      env.R2_BUCKET_NAME &&
      env.R2_SECRET_ACCESS_KEY
  );

export const signR2PutUrl = async (
  env: Bindings,
  key: string,
  input: { contentType?: string; partNumber?: number; uploadId?: string } = {}
): Promise<{ headers: Record<string, string>; url: string }> => {
  const config = signingConfig(env);
  const headers: Record<string, string> = {};
  if (input.contentType) {
    headers["content-type"] = input.contentType;
  }
  const url = objectUrl(config, key);
  if (input.partNumber !== undefined && input.uploadId !== undefined) {
    url.searchParams.set("partNumber", String(input.partNumber));
    url.searchParams.set("uploadId", input.uploadId);
  }
  url.searchParams.set("X-Amz-Expires", String(presignedUrlTtlSeconds));
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });
  const signed = await client.sign(url, {
    aws: { allHeaders: true, signQuery: true },
    headers,
    method: "PUT",
  });
  return { headers, url: signed.url };
};

const signingConfig = (env: Bindings): SigningConfig => {
  if (!hasR2SigningConfig(env)) {
    throw new Error("R2 direct-upload signing is not configured");
  }
  return {
    accessKeyId: env.R2_ACCESS_KEY_ID ?? "",
    accountId: env.R2_ACCOUNT_ID ?? "",
    bucketName: env.R2_BUCKET_NAME ?? "",
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? "",
  };
};

const objectUrl = (config: SigningConfig, key: string): URL => {
  const path = [config.bucketName, ...key.split("/")]
    .map(encodeURIComponent)
    .join("/");
  return new URL(
    `https://${config.accountId}.r2.cloudflarestorage.com/${path}`
  );
};
