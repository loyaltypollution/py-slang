import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from '@rollup/plugin-typescript';
import json from '@rollup/plugin-json';
import wasm from '@rollup/plugin-wasm';
import commonjs from '@rollup/plugin-commonjs';
import nodePolyfills from 'rollup-plugin-polyfill-node';

/**
 * @type {import('rollup').RollupOptions}
 */
const config = [{
  input: 'src/index.ts',
  output: {
    file: 'dist/worker.js',
    format: 'iife',
    name: 'PySlangWorker'
  },
  // must allow 91 kb
  plugins: [wasm({maxFileSize: 2000000}), commonjs(), json(), typescript(), nodeResolve(), nodePolyfills()]
},
{
  input: 'src/conductor/PyEvaluator.ts',
  output: {
    file: 'dist/python-evaluator.cjs',
    format: 'cjs',
    name: 'PySlangEvaluator'
  },
  plugins: [wasm({maxFileSize: 2000000}), commonjs(), json(), typescript(), nodeResolve(), nodePolyfills()]
},
{
  input: 'src/cli/svmc.ts',
  output: {
    file: 'dist/svmc.cjs',
    format: 'cjs',
    name: 'SVMC'
  },
  plugins: [commonjs(), json(), typescript(), nodeResolve()]
},
{
  input: 'src/cli/ast-to-dot.ts',
  output: {
    file: 'dist/ast-to-dot.cjs',
    format: 'cjs',
    name: 'AstViz'
  },
  plugins: [commonjs(), json(), typescript(), nodeResolve()]
},
{
  input: 'src/vm/test-interpreter.ts',
  output: {
    file: 'dist/test-interpreter.cjs',
    format: 'cjs',
    name: 'TestInterpreter'
  },
  plugins: [commonjs(), json(), typescript(), nodeResolve()]
}];

export default config;
