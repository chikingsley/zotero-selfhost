declare module "bsdiff-wasm" {
  interface BspatchFileSystem {
    mkdir(path: string): void;
    readFile(path: string): Uint8Array;
    rmdir(path: string): void;
    unlink(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
  }

  interface BspatchModule {
    FS: BspatchFileSystem;
    callMain(args: string[]): unknown;
  }

  export function loadBspatch(
    options?: Record<string, unknown>
  ): Promise<BspatchModule>;
}
