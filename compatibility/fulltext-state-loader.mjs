const upstreamHelperSuffix = "/tests/remote/dynamodb-helper.js";
const adapterURL = new URL("./fulltext-state-adapter.mjs", import.meta.url)
  .href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);

  if (resolved.url.endsWith(upstreamHelperSuffix)) {
    return {
      shortCircuit: true,
      url: adapterURL,
    };
  }

  return resolved;
}
