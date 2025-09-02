import fs from "fs";
import sinterwasm from "./sinterwasm.js";
import wasm from "./sinterwasm.wasm";

const future = async (props: any) => {
  const module = await sinterwasm({
    instantiateWasm(imports: WebAssembly.Imports, callback: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) {
      return wasm(imports).then(result => {
        callback(result.instance, result.module);
        return result.instance.exports;
      });
    },
    ...props,
  });

  if (!module.cwrap) {
    console.error("module has no cwrap", module);
    throw new Error("module has no cwrap");
  }
  const alloc_heap = module.cwrap("siwasm_alloc_heap", undefined, ["number"]);
  const alloc = module.cwrap("siwasm_alloc", "number", ["number"]);
  const free = module.cwrap("siwasm_free", undefined, ["number"]);
  const run = module.cwrap("siwasm_run", undefined, ["number", "number"]);
  return {
    module,
    alloc_heap,
    alloc,
    free,
    run,
    // Convenience function to run bytecode from JavaScript buffer
    runBuffer: (buffer: Uint8Array) => {
      // Allocate WASM memory for the buffer
      const ptr = alloc(buffer.length);
      if (!ptr) {
        throw new Error("Failed to allocate WASM memory");
      }
      
      try {
        // Copy buffer into WASM memory
        module.HEAPU8.set(buffer, ptr);
        
        // Run the bytecode
        run(ptr, buffer.length);
      } finally {
        // Clean up allocated memory
        free(ptr);
      }
    }
  };
};

if (require.main === module) {
  future({}).then((sinter) => {
    fs.readFile("test.svm", (err, buffer) => {
      if (err) {
        console.error(err);
        return;
      }
      sinter.runBuffer(buffer);
    })
  });
}

export default future;