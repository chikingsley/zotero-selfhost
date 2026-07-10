# bsdiff-wasm Worker compatibility

Zotero's file-upload protocol accepts `bsdiff` partial attachment updates. The
server therefore needs the `bspatch` implementation from `bsdiff-wasm`.

Version 0.1.4 is the current upstream release. Its generated Emscripten loader
mistakes a Cloudflare Worker using `nodejs_compat` for ordinary Node.js and
selects a filesystem loader that eventually calls the unavailable private
`process.binding()` API. It also does not export the compiled WebAssembly module
or honor Emscripten's `instantiateWasm` callback.

`cloudflare-worker.patch` keeps the browser-style loader path, exports
`bspatch.wasm`, and enables `Module.instantiateWasm`. `src/lib/patch.ts` then
imports Wrangler's compiled `WebAssembly.Module` and instantiates it explicitly.

Remove this vendor patch only after upstream publishes a release that exports
the Wasm module and supports custom instantiation in Cloudflare Workers. Any
replacement must pass `tests/patch-runtime.test.ts`, route-level partial-upload
tests, and a real Zotero Desktop attachment-update smoke test.

Upstream: <https://github.com/kairi003/bsdiff-wasm>

Cloudflare Wasm modules: <https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/>

Emscripten `Module.instantiateWasm`: <https://emscripten.org/docs/api_reference/module.html#module-instantiatewasm>
