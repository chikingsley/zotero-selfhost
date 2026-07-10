type CLIOptions = Record<string, boolean | string>;

interface CloudflareCredentials {
  accountID: string;
  apiToken: string;
}

export const runAdminCommand = async (
  command: string | undefined,
  options: CLIOptions
): Promise<void> => {
  if (command === "restore-d1") {
    const { restoreD1 } = await import("../internal/d1-recovery.ts");
    await restoreD1({
      ...readCloudflareCredentials(),
      databaseID: readRequiredOption(options, "database-id"),
      inputPath: readRequiredOption(options, "input"),
    });
    return;
  }

  if (command === "copy-r2") {
    const { copyR2 } = await import("../internal/r2-recovery.ts");
    await copyR2({
      ...readCloudflareCredentials(),
      destinationBucket: readRequiredOption(options, "destination-bucket"),
      sourceBucket: readRequiredOption(options, "source-bucket"),
    });
    return;
  }

  if (command === "empty-r2-drill") {
    const { emptyR2Drill } = await import("../internal/r2-recovery.ts");
    await emptyR2Drill({
      ...readCloudflareCredentials(),
      bucket: readRequiredOption(options, "bucket"),
    });
    return;
  }

  throw new Error(
    `Unknown admin command '${command ?? ""}'. Use restore-d1, copy-r2, or empty-r2-drill.`
  );
};

const readCloudflareCredentials = (): CloudflareCredentials => ({
  accountID: readRequiredEnvironment("CLOUDFLARE_ACCOUNT_ID"),
  apiToken: readRequiredEnvironment("CLOUDFLARE_API_TOKEN"),
});

const readRequiredEnvironment = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const readRequiredOption = (options: CLIOptions, name: string): string => {
  const value = options[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`--${name} is required.`);
  }
  return value.trim();
};
