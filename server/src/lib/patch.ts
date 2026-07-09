import { loadBspatch } from "bsdiff-wasm";
import xdelta3Wasm from "xdelta3-wasm/dist/df58e7ef369c5c18.wasm";

export class PatchAlgorithmUnavailableError extends Error {
  constructor(algorithm: string, options?: ErrorOptions) {
    super(
      `Patch algorithm '${algorithm}' is not available in this runtime`,
      options
    );
    this.name = "PatchAlgorithmUnavailableError";
  }
}

export class PatchApplicationError extends Error {
  constructor(algorithm: string, options: ErrorOptions) {
    super(
      `Patch algorithm '${algorithm}' failed: ${String(options.cause)}`,
      options
    );
    this.name = "PatchApplicationError";
  }
}

export const applyZoteroPatch = async (
  algorithm: string,
  original: ArrayBuffer,
  patch: ArrayBuffer
): Promise<ArrayBuffer> => {
  switch (algorithm) {
    case "bsdiff":
      return applyBsdiffPatch(original, patch);
    case "vcdiff":
    case "xdelta":
      return applyXdeltaPatch(algorithm, original, patch);
    case "xdiff":
      throw new PatchAlgorithmUnavailableError(algorithm);
    default:
      throw new PatchAlgorithmUnavailableError(algorithm);
  }
};

const applyBsdiffPatch = async (
  original: ArrayBuffer,
  patch: ArrayBuffer
): Promise<ArrayBuffer> => {
  const bspatch = await loadBspatch({
    print: () => undefined,
    printErr: () => undefined,
  });
  const workdir = `/patch-${crypto.randomUUID()}`;

  try {
    bspatch.FS.mkdir(workdir);
    bspatch.FS.writeFile(`${workdir}/original`, new Uint8Array(original));
    bspatch.FS.writeFile(`${workdir}/patch`, new Uint8Array(patch));
    bspatch.callMain([
      `${workdir}/original`,
      `${workdir}/new`,
      `${workdir}/patch`,
    ]);

    const bytes = bspatch.FS.readFile(`${workdir}/new`);
    const output = new Uint8Array(bytes.byteLength);
    output.set(bytes);
    return output.buffer;
  } catch (error) {
    throw new PatchApplicationError("bsdiff", { cause: error });
  } finally {
    unlinkIfExists(bspatch, `${workdir}/original`);
    unlinkIfExists(bspatch, `${workdir}/patch`);
    unlinkIfExists(bspatch, `${workdir}/new`);
    rmdirIfExists(bspatch, workdir);
  }
};

const maxXdeltaOutputBytes = 512 * 1024 * 1024;
const minXdeltaOutputBytes = 1024 * 1024;
const wasiErrnoSuccess = 0;
const wasiErrnoNoSpace = 51;

interface Xdelta3Exports extends WebAssembly.Exports {
  free: (ptr: number) => void;
  malloc: (size: number) => number;
  memory: WebAssembly.Memory;
  xd3_decode_memory: (
    inputPtr: number,
    inputSize: number,
    sourcePtr: number,
    sourceSize: number,
    outputPtr: number,
    outputSizePtr: number,
    outputSizeMax: number,
    flags: number
  ) => number;
  xd3_strerror: (code: number) => number;
}

let xdelta3InstancePromise: Promise<WebAssembly.Instance> | null = null;

// Instantiate lazily. Doing this at module scope crashed the entire Worker on
// import in any runtime where the imported `.wasm` is not already a compiled
// `WebAssembly.Module` (e.g. the Node/Vitest test runner). Defer it to first
// use and surface an unavailable-algorithm error instead of taking down boot.
const getXdelta3Instance = async (): Promise<WebAssembly.Instance> => {
  if (!xdelta3InstancePromise) {
    xdelta3InstancePromise = (async () => {
      const result: unknown = await WebAssembly.instantiate(
        xdelta3Wasm as WebAssembly.Module,
        {}
      );
      if (result instanceof WebAssembly.Instance) {
        return result;
      }
      return (result as { instance: WebAssembly.Instance }).instance;
    })();
  }

  try {
    return await xdelta3InstancePromise;
  } catch (error) {
    xdelta3InstancePromise = null;
    throw new PatchAlgorithmUnavailableError("xdelta", { cause: error });
  }
};

const applyXdeltaPatch = async (
  algorithm: string,
  original: ArrayBuffer,
  patch: ArrayBuffer
): Promise<ArrayBuffer> => {
  const instance = await getXdelta3Instance();
  const xdelta3 = instance.exports as Xdelta3Exports;

  const source = new Uint8Array(original);
  const delta = new Uint8Array(patch);
  let outputSizeMax = Math.max(
    minXdeltaOutputBytes,
    original.byteLength + patch.byteLength
  );

  while (outputSizeMax <= maxXdeltaOutputBytes) {
    const result = decodeXdeltaMemory(xdelta3, delta, source, outputSizeMax);

    if (result.ret === wasiErrnoSuccess) {
      const output = new Uint8Array(result.output.byteLength);
      output.set(result.output);
      return output.buffer;
    }

    if (result.ret !== wasiErrnoNoSpace) {
      throw new PatchApplicationError(algorithm, {
        cause: `${result.str} (${result.ret})`,
      });
    }

    outputSizeMax *= 2;
  }

  throw new PatchApplicationError(algorithm, {
    cause: `decoded output exceeded ${maxXdeltaOutputBytes} bytes`,
  });
};

const decodeXdeltaMemory = (
  xdelta3: Xdelta3Exports,
  input: Uint8Array,
  source: Uint8Array,
  outputSizeMax: number
) => {
  const inputPtr = xdelta3.malloc(Math.max(1, input.byteLength));
  const sourcePtr = xdelta3.malloc(Math.max(1, source.byteLength));
  const outputPtr = xdelta3.malloc(outputSizeMax);
  const outputSizePtr = xdelta3.malloc(4);

  try {
    writeToXdeltaMemory(xdelta3, inputPtr, input);
    writeToXdeltaMemory(xdelta3, sourcePtr, source);

    const ret = xdelta3.xd3_decode_memory(
      inputPtr,
      input.byteLength,
      sourcePtr,
      source.byteLength,
      outputPtr,
      outputSizePtr,
      outputSizeMax,
      0
    );
    const outputSize = new DataView(xdelta3.memory.buffer).getUint32(
      outputSizePtr,
      true
    );
    const output = new Uint8Array(outputSize);
    output.set(new Uint8Array(xdelta3.memory.buffer, outputPtr, outputSize));

    return {
      output,
      ret,
      str:
        ret === wasiErrnoSuccess
          ? "SUCCESS"
          : readXdeltaCString(xdelta3, xdelta3.xd3_strerror(ret)),
    };
  } finally {
    xdelta3.free(inputPtr);
    xdelta3.free(sourcePtr);
    xdelta3.free(outputPtr);
    xdelta3.free(outputSizePtr);
  }
};

const writeToXdeltaMemory = (
  xdelta3: Xdelta3Exports,
  ptr: number,
  data: Uint8Array
) => {
  if (data.byteLength === 0) {
    return;
  }

  new Uint8Array(xdelta3.memory.buffer, ptr, data.byteLength).set(data);
};

const readXdeltaCString = (xdelta3: Xdelta3Exports, ptr: number): string => {
  let end = ptr;
  const memory = new Uint8Array(xdelta3.memory.buffer);
  while (memory[end] !== 0) {
    end += 1;
  }

  return new TextDecoder().decode(memory.subarray(ptr, end));
};

const unlinkIfExists = (
  bspatch: Awaited<ReturnType<typeof loadBspatch>>,
  path: string
) => {
  try {
    bspatch.FS.unlink(path);
  } catch {
    // Best-effort cleanup in the wasm in-memory filesystem.
  }
};

const rmdirIfExists = (
  bspatch: Awaited<ReturnType<typeof loadBspatch>>,
  path: string
) => {
  try {
    bspatch.FS.rmdir(path);
  } catch {
    // Best-effort cleanup in the wasm in-memory filesystem.
  }
};
