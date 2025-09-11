// Global TypeScript declarations for importing WebAssembly binaries
declare module "*.wasm" {
  const wasmModule: (imports: WebAssembly.Imports) => Promise<WebAssembly.WebAssemblyInstantiatedSource>;
  export default wasmModule;
}


