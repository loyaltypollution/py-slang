#!/usr/bin/env node

import { Tokenizer } from "./tokenizer";
import { Parser } from "./parser";
import { Translator } from "./translator";
import { Resolver } from "./resolver";
import type { Program } from "estree";
import { compileToIns } from './vm/svml-compiler';
import { assemble } from './vm/svml-assembler';
import { stringifyProgram } from './vm/util';
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
 * Format SVML program as JSON string
 */
function formatSVMLProgram(program: any): string {
    return JSON.stringify(program, null, 2);
}

/**
 * CLI tool for compiling Python to SVML bytecode
 * Usage: 
 *   node cli-svml-compiler.js <input-file> [output-file] [format=binary|text]
 *   node cli-svml-compiler.js --code "print('hello')" [output-file] [format=binary|text]
 */
function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('SVML Compiler CLI');
        console.log('');
        console.log('Usage:');
        console.log('  node cli-svml-compiler.js <input-file> [output-file] [format=binary|text]');
        console.log('  node cli-svml-compiler.js --code "print(\'hello\')" [output-file] [format=binary|text]');
        console.log('');
        console.log('Options:');
        console.log('  format=binary  Output as binary bytecode (default)');
        console.log('  format=text    Output as human-readable text');
        console.log('');
        console.log('Examples:');
        console.log('  node cli-svml-compiler.js test.py');
        console.log('  node cli-svml-compiler.js test.py bytecode.svm');
        console.log('  node cli-svml-compiler.js --code "x = 1 + 2" format=text');
        process.exit(1);
    }

    let pythonCode: string;
    let outputFile: string;
    let format = 'binary';

    // Parse arguments
    const filteredArgs = args.filter(arg => {
        if (arg.startsWith('format=')) {
            format = arg.split('=')[1];
            return false;
        }
        return true;
    });

    if (filteredArgs[0] === '--code') {
        if (filteredArgs.length < 2) {
            console.error('Error: --code requires a Python code string');
            process.exit(1);
        }
        pythonCode = filteredArgs[1];
        outputFile = filteredArgs[2] || `output.${format === 'text' ? 'txt' : 'bin'}`;
    } else {
        const inputFile = filteredArgs[0];
        outputFile = filteredArgs[1] || inputFile.replace(/\.py$/, format === 'text' ? '.txt' : '.svm');
        
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
        
        console.log('Compiling to SVML bytecode...');
        const program = compileToIns(ast);
        
        console.log('Formatting output...');
        
        // Ensure output directory exists
        const outputDir = path.dirname(outputFile);
        if (outputDir && !fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        if (format === 'text') {
            const outputContent = stringifyProgram(program);
            fs.writeFileSync(outputFile, outputContent);
        } else {
            // Binary format
            const binaryData = assemble(program);
            fs.writeFileSync(outputFile, binaryData);
        }
        
        console.log(`SVML bytecode saved to: ${outputFile}`);
        
        // Show file size and stats
        const stats = fs.statSync(outputFile);
        console.log(`File size: ${stats.size} bytes`);
        
        // Show compilation stats
        const [entryPoint, functions] = program;
        console.log(`\nCompilation Summary:`);
        console.log(`  Entry Point: Function ${entryPoint}`);
        console.log(`  Total Functions: ${functions.length}`);
        console.log(`  Total Instructions: ${functions.reduce((total: number, func: any) => total + func[3].length, 0)}`);
        
        // Show preview of the output for text format only
        if (format === 'text') {
            const outputContent = stringifyProgram(program);
            console.log('\nPreview of output:');
            const lines = outputContent.split('\n');
            const previewLines = lines.slice(0, 20);
            console.log(previewLines.join('\n'));
            if (lines.length > 20) {
                console.log('...');
                console.log(`(showing first 20 lines of ${lines.length} total)`);
            }
        } else {
            console.log('\nBinary bytecode file created successfully.');
        }
        
    } catch (error) {
        console.error('Error compiling Python to SVML:', error);
        if (error instanceof Error) {
            console.error('Stack trace:', error.stack);
        }
        process.exit(1);
    }
}

// Run the CLI if this file is executed directly
if (require.main === module) {
    main();
}

export { parsePythonToEstreeAst, formatSVMLProgram };
