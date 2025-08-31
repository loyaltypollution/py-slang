import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from '@rollup/plugin-typescript';
import json from '@rollup/plugin-json';
import commonjs from '@rollup/plugin-commonjs';

/**
 * @type {import('rollup').RollupOptions}
 */
const config = [{
  input: 'src/cli-ast-visualizer.ts',
  output: {
    file: 'dist/cli-ast-visualizer.mjs',
    format: 'es',
  },
  plugins: [commonjs(), json(), typescript(), nodeResolve()]}, {
  input: 'src/conductor/PyEvaluator.ts',
  output: {
    file: 'dist/python-evaluator.cjs',
    format: 'cjs',
    name: 'PySlangRunner',
    sourcemap: true
  },
  plugins: [commonjs(), json(), typescript(), nodeResolve()]
}, {
  input: 'src/index.ts',
  output: {
    file: 'dist/worker.js',
    format: 'iife',
    name: 'PySlangWorker',
    sourcemap: true
  },
  plugins: [commonjs(), json(), typescript(), nodeResolve()]
}];

export default config;
