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
}];

export default config;
