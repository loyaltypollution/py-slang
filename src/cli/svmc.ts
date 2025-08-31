#!/usr/bin/env node

import { Command } from 'commander';
import { Tokenizer } from "../tokenizer";
import { Parser } from "../parser";
import { Translator } from "../translator";
import { Resolver } from "../resolver";
import type { Program } from "estree";
import { assemble } from '../vm/svml-assembler';
import { stringifyProgram } from '../vm/util';
import * as fs from 'fs';
import * as path from 'path';
import { compileDirect } from "../vm/svml-compiler";

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
 * Compile Python code to SVML bytecode
 */
function compilePythonToSVML(pythonCode: string, outputFile: string, format: string) {
    try {
        console.log('Parsing Python code...');
        const ast = parsePythonToEstreeAst(pythonCode, 1, true);
        
        console.log('Compiling to SVML bytecode...');
        const program = compileDirect(ast);
        
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

/**
 * CLI tool for compiling Python to SVML bytecode
 */
function main() {
    const program = new Command();
    
    program
        .name('svmc')
        .description('SVML Compiler - Compile Python to SVML bytecode')
        .version('1.0.0');

    program
        .command('compile')
        .description('Compile Python file to SVML bytecode')
        .argument('<input-file>', 'Python file to compile')
        .option('-o, --output <file>', 'Output file path')
        .option('-f, --format <format>', 'Output format (binary|text)', 'binary')
        .action((inputFile: string, options: any) => {
            if (!fs.existsSync(inputFile)) {
                console.error(`Error: File '${inputFile}' not found`);
                process.exit(1);
            }
            
            const outputFile = options.output || inputFile.replace(/\.py$/, options.format === 'text' ? '.txt' : '.svm');
            
            try {
                const pythonCode = fs.readFileSync(inputFile, 'utf8');
                compilePythonToSVML(pythonCode, outputFile, options.format);
            } catch (error) {
                console.error(`Error reading file '${inputFile}':`, error);
                process.exit(1);
            }
        });

    program.parse(process.argv);
}

// Run the CLI if this file is executed directly
if (require.main === module) {
    main();
}

export { parsePythonToEstreeAst, formatSVMLProgram };
