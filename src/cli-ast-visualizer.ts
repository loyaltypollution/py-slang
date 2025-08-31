#!/usr/bin/env node

import { Tokenizer } from "./tokenizer";
import { Parser } from "./parser";
import { Translator } from "./translator";
import { Resolver } from "./resolver";
import { Program } from "estree";
import { visualizeAST } from './ast-visualizer';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Standalone function to parse Python to EsTree AST without browser dependencies
 */
function parsePythonToEstreeAst(code: string, variant: number = 1, doValidate: boolean = false): Program {
    const script = code + '\n'
    const tokenizer = new Tokenizer(script)
    const tokens = tokenizer.scanEverything()
    const pyParser = new Parser(script, tokens)
    const ast = pyParser.parse()
    if (doValidate) {
        new Resolver(script, ast).resolve(ast);
    }
    const translator = new Translator(script)
    return translator.resolve(ast) as unknown as Program
}

/**
 * CLI tool for generating AST visualizations
 * Usage: 
 *   node standalone-ast-visualizer.js <input-file> [output-file]
 *   node standalone-ast-visualizer.js --code "print('hello')" [output-file]
 */
function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('AST Visualizer CLI (Standalone)');
    console.log('');
    console.log('Usage:');
    console.log('  node standalone-ast-visualizer.js <input-file> [output-file]');
    console.log('  node standalone-ast-visualizer.js --code "print(\'hello\')" [output-file]');
    console.log('');
    console.log('Examples:');
    console.log('  node standalone-ast-visualizer.js test.py');
    console.log('  node standalone-ast-visualizer.js test.py ast-output.dot');
    console.log('  node standalone-ast-visualizer.js --code "x = 1 + 2"');
    console.log('');
    console.log('The output will be a DOT file that can be visualized using:');
    console.log('  - Online: https://dreampuf.github.io/GraphvizOnline/');
    console.log('  - Command line: dot -Tpng output.dot -o output.png');
    console.log('  - VS Code: Install Graphviz extension');
    process.exit(1);
  }

  let pythonCode: string;
  let outputFile: string;

  if (args[0] === '--code') {
    if (args.length < 2) {
      console.error('Error: --code requires a Python code string');
      process.exit(1);
    }
    pythonCode = args[1];
    outputFile = args[2] || 'ast-output.dot';
  } else {
    const inputFile = args[0];
    outputFile = args[1] || inputFile.replace(/\.py$/, '.dot');
    
    if (!fs.existsSync(inputFile)) {
      console.error(`Error: File '${inputFile}' not found`);
      process.exit(1);
    }
    
    try {
      pythonCode = fs.readFileSync(inputFile, 'utf8');
    } catch (error) {
      console.error(`Error reading file '${inputFile}':`, error);
      process.exit(1);
    }
  }

  try {
    console.log('Parsing Python code...');
    const ast = parsePythonToEstreeAst(pythonCode, 1, true);
    
    console.log('Generating AST visualization...');
    const title = `AST: ${path.basename(outputFile, '.dot')}`;
    const dotContent = visualizeAST(ast, title);
    
    // Ensure output directory exists
    const outputDir = path.dirname(outputFile);
    if (outputDir && !fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    fs.writeFileSync(outputFile, dotContent);
    console.log(`AST visualization saved to: ${outputFile}`);
    
    // Show file size
    const stats = fs.statSync(outputFile);
    console.log(`File size: ${stats.size} bytes`);
    
    // Show preview of the DOT content
    console.log('\nPreview of DOT content:');
    const lines = dotContent.split('\n');
    const previewLines = lines.slice(0, 20);
    console.log(previewLines.join('\n'));
    if (lines.length > 20) {
      console.log('...');
      console.log(`(showing first 20 lines of ${lines.length} total)`);
    }
    
  } catch (error) {
    console.error('Error generating AST visualization:', error);
    process.exit(1);
  }
}

// Run the CLI if this file is executed directly
if (require.main === module) {
  main();
}
