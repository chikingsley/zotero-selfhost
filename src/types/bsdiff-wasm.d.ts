declare module "bsdiff-wasm/bspatch" {
  interface BspatchFileSystem {
    mkdir: (path: string) => void;
    readFile: (path: string) => Uint8Array;
    rmdir: (path: string) => void;
    unlink: (path: string) => void;
    writeFile: (path: string, data: Uint8Array) => void;
  }

  interface BspatchModule {
    callMain: (args: string[]) => unknown;
    FS: BspatchFileSystem;
  }

  export default function loadBspatch(
    options?: Record<string, unknown>
  ): Promise<BspatchModule>;
}

declare module "bsdiff-wasm/bspatch.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
