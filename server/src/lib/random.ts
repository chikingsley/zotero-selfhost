export const randomString = (alphabet: string, length: number): string => {
  if (alphabet.length === 0 || alphabet.length > 256) {
    throw new Error("Random-string alphabet must contain 1 to 256 characters");
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error("Random-string length must be a non-negative integer");
  }

  const output: string[] = [];
  const unbiasedLimit = 256 - (256 % alphabet.length);
  while (output.length < length) {
    const bytes = new Uint8Array(Math.max(32, length - output.length));
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < unbiasedLimit) {
        output.push(alphabet[byte % alphabet.length] ?? "");
      }
      if (output.length === length) {
        break;
      }
    }
  }

  return output.join("");
};
