# Wasm assets

Store the source retracer generated JavaScript glue in this directory.

The wasm binary itself is stored as a base64 blob in
`src/generated/actonSourceTraceWasm.ts`. `yarn build` converts the generated
JavaScript glue into `src/generated/actonSourceTraceWasmGlue.ts`.
