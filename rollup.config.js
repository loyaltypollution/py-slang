import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from '@rollup/plugin-typescript';
import json from '@rollup/plugin-json';
import wasm from '@rollup/plugin-wasm';
import commonjs from '@rollup/plugin-commonjs';

/**
 * @type {import('rollup').RollupOptions}
 */
const config = [
  {
  input: 'src/conductor/PyEvaluator.ts',
  output: {
    file: 'dist/python-evaluator.cjs',
    format: 'cjs',
    name: 'PySlangRunner',
    sourcemap: true
  },
  plugins: [wasm(), commonjs(), json(), typescript(), nodeResolve()]
}, {
  input: 'src/index.ts',
  output: {
    file: 'dist/worker.js',
    format: 'iife',
    name: 'PySlangWorker',
    sourcemap: true
  },
  plugins: [wasm(), commonjs(), json(), typescript(), nodeResolve()]
}, 
{
  input: 'src/sinter/sinter.ts',
  output: {
    file: 'dist/sinter.js',
    format: 'cjs',
    name: 'Sinter',
  },
  external: ['fs', 'path'],
  plugins: [wasm(), commonjs(), typescript()]
}];

export default config;
