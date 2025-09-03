import sinterwasm from "./sinterwasm.js";
import wasm from "./sinterwasm.wasm";
import { Value } from "../cse-machine/stash";

// Define the sinter module interface
interface SinterModule {
  module: any;
  alloc_heap: (size: number) => void;
  alloc: (size: number) => number;
  free: (ptr: number) => void;
  run: (ptr: number, size: number) => number;
  runBinary: (buffer: Uint8Array) => Value;
}

// Initialize the sinter WASM module
export default async function init(props: any = {}): Promise<SinterModule> {
  const module = await sinterwasm({
    instantiateWasm(imports: WebAssembly.Imports, callback: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) {
      return wasm(imports).then((result: WebAssembly.WebAssemblyInstantiatedSource) => {
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
  const run = module.cwrap("siwasm_run", "number", ["number", "number"]);

  // Helper function to read return value from WASM memory
  const readReturnValue = (resPtr: number): Value => {
    const type = module.HEAP8[resPtr]
                   | (module.HEAP8[resPtr + 1] << 8)
                   | (module.HEAP8[resPtr + 2] << 16)
                   | (module.HEAP8[resPtr + 3] << 24);
    const retVal = module.HEAP8[resPtr + 4]
                   | (module.HEAP8[resPtr + 5] << 8)
                   | (module.HEAP8[resPtr + 6] << 16)
                   | (module.HEAP8[resPtr + 7] << 24);
    
    switch(type) {
      case 1: // sinter_type_undefined = 1,
        return { type: 'undefined' };
      case 2: // sinter_type_null = 2,
        return { type: 'NoneType', value: undefined };
      case 3: // sinter_type_boolean = 3,
        return { type: 'bool', value: retVal === 1 };
      case 4: // sinter_type_integer = 4,
        return { type: 'bigint', value: retVal };
      case 5: // sinter_type_float = 5,
        throw new Error("Type not yet supported");
      case 6: // sinter_type_string = 6,
        throw new Error("Type not yet supported");    
      case 7: // sinter_type_array = 7,
        throw new Error("Type not yet supported");
      case 8: // sinter_type_function = 8
        throw new Error("Type not yet supported");
      default:
        throw new Error(`Unknown return type: ${type}`);
    }
  };

  // Main function to run binary and return result
  const runBinary = (buffer: Uint8Array): Value => {
    // Allocate WASM memory for the buffer
    const ptr = alloc(buffer.length);
    if (!ptr) {
      throw new Error("Failed to allocate WASM memory");
    }
    let resPtr = 0;
    
    try {
      // Copy buffer into WASM memory
      module.HEAPU8.set(buffer, ptr);
      
      // Run the bytecode and get result pointer
      resPtr = run(ptr, buffer.length);
      
      // Read and return the result
      return readReturnValue(resPtr);
    } finally {
      // Clean up allocated memory
      free(ptr);
    }
  };

  return {
    module,
    alloc_heap,
    alloc,
    free,
    run,
    runBinary,
  };
};