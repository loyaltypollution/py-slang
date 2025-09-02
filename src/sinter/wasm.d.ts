// TypeScript declarations for WASM modules
declare module "*.wasm" {
    const wasmModule: (imports: WebAssembly.Imports) => Promise<WebAssembly.WebAssemblyInstantiatedSource>;
    export default wasmModule;
  }
  