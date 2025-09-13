#!/usr/bin/env node

import { Command } from 'commander';
import { Tokenizer } from "../tokenizer";
import { Parser } from "../parser";
import { Resolver } from "../resolver";
import { StmtNS } from "../ast-types";
import PyASTVisualizer from '../utils/astVisualizer';
import * as fs from 'fs';

/**
 * Parse Python code to Python AST without translation to ESTree
 */
function parsePythonToAst(code: string, variant: number = 1, doValidate: boolean = false): StmtNS.FileInput {
    const script = code + '\n'
    const tokenizer = new Tokenizer(script)
    const tokens = tokenizer.scanEverything()
    const pyParser = new Parser(script, tokens)
    const ast = pyParser.parse()
    if (doValidate) {
        new Resolver(script, ast).resolve(ast);
    }
    // The parser should always return a FileInput for top-level parsing
    if (!(ast instanceof StmtNS.FileInput)) {
        throw new Error('Expected FileInput as root AST node');
    }
    return ast
}

/**
 * Generate AST visualization from Python code
 */
function generateASTVisualization(pythonCode: string, outputFile: string) {
    try {
        const ast = parsePythonToAst(pythonCode, 1, true);
        
        const astVisualizer = new PyASTVisualizer();
        astVisualizer.saveToFile(ast, outputFile);
    } catch (error) {
        console.error('Error generating AST visualization:', error);
        if (error instanceof Error) {
            console.error('Stack trace:', error.stack);
        }
        process.exit(1);
    }
}

/**
 * CLI tool for generating AST visualizations
 */
function main() {
    const program = new Command();
    
    program
        .name('ast-to-dot')
        .description('Python AST Visualizer - Generate DOT visualizations of Python ASTs')
        .version('1.0.0');

    program
        .command('file')
        .description('Generate AST visualization from Python file')
        .argument('<input-file>', 'Python file to visualize')
        .option('-o, --output <file>', 'Output DOT file path')
        .action((inputFile: string, options: any) => {
            if (!fs.existsSync(inputFile)) {
                console.error(`Error: File '${inputFile}' not found`);
                process.exit(1);
            }
            
            const outputFile = options.output || inputFile.replace(/\.py$/, '.dot');
            
            try {
                const pythonCode = fs.readFileSync(inputFile, 'utf8');
                generateASTVisualization(pythonCode, outputFile);
            } catch (error) {
                console.error(`Error reading file '${inputFile}':`, error);
                process.exit(1);
            }
        });

    // Show help if no command is provided
    if (process.argv.length === 2) {
        program.outputHelp();
        console.log('\nExamples:');
        console.log('  ast-to-dot file test.py');
        console.log('  ast-to-dot file test.py -o ast-output.dot');
        process.exit(0);
    }

    program.parse(process.argv);
}

// Run the CLI if this file is executed directly
if (require.main === module) {
    main();
}
