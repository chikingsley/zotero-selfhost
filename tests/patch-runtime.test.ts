import { describe, expect, it } from "vitest";
import {
  applyZoteroPatch,
  PatchAlgorithmUnavailableError,
} from "../src/lib/patch";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const asArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const decodeBase64 = (value: string): ArrayBuffer =>
  asArrayBuffer(
    Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  );

describe("Zotero patch engines in the Workers runtime", () => {
  it("applies a bsdiff patch with the bundled bspatch WebAssembly module", async () => {
    const original = "The quick brown fox jumps over the lazy dog.";
    const expected = "The quick red fox vaults over the very lazy dog!";
    const patch = decodeBase64(
      "QlNESUZGNDAsAAAAAAAAACcAAAAAAAAAMAAAAAAAAABCWmg5MUFZJlNZZvHwWAAAD8AASFsgACEkMQhgL2OWAKi8XckU4UJBm8fBYEJaaDkxQVkmU1nRoyCCAAAAYABAACAAIAAhAIKDF3JFOFCQ0aMggkJaaDkxQVkmU1my1MCEAAAIkYBgACeEl3AgADFMABNCmjRg01BVC5mGC6CGbDxbGPDnxdyRThQkLLUwIQA="
    );

    const output = await applyZoteroPatch(
      "bsdiff",
      asArrayBuffer(encoder.encode(original)),
      patch
    );

    expect(decoder.decode(output)).toBe(expected);
  });

  it.each([
    "xdelta",
    "vcdiff",
  ] as const)("applies the known xdelta fixture through the %s name", async (algorithm) => {
    const source = encoder.encode("Hello, world!");
    const delta = new Uint8Array([
      214, 195, 196, 0, 0, 1, 13, 0, 39, 43, 0, 30, 3, 1, 32, 84, 104, 105, 115,
      32, 105, 115, 32, 97, 32, 116, 101, 115, 116, 46, 32, 72, 101, 108, 108,
      111, 44, 32, 119, 111, 114, 108, 100, 33, 29, 1, 30, 0,
    ]);

    const output = await applyZoteroPatch(
      algorithm,
      asArrayBuffer(source),
      asArrayBuffer(delta)
    );

    expect(decoder.decode(output)).toBe(
      "Hello, world! This is a test. Hello, world!"
    );
  });

  it("reports the unsupported xdiff algorithm explicitly", async () => {
    await expect(
      applyZoteroPatch("xdiff", new ArrayBuffer(0), new ArrayBuffer(0))
    ).rejects.toBeInstanceOf(PatchAlgorithmUnavailableError);
  });
});
