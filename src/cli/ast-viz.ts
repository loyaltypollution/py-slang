#!/usr/bin/env node

import { Command } from 'commander';
import { Tokenizer } from "../tokenizer";
import { Parser } from "../parser";
import { Translator } from "../translator";
import { Resolver } from "../resolver";
import { Program } from "estree";
import { visualizeAST } from '../utils/ast/astVisualizer';
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
 * Generate AST visualization from Python code
 */
function generateASTVisualization(pythonCode: string, outputFile: string) {
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
        .name('ast-viz')
        .description('AST Visualizer - Generate DOT visualizations of Python ASTs')
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

    program
        .command('code')
        .description('Generate AST visualization from Python code string')
        .argument('<python-code>', 'Python code to visualize')
        .option('-o, --output <file>', 'Output DOT file path', 'ast-output.dot')
        .action((pythonCode: string, options: any) => {
            generateASTVisualization(pythonCode, options.output);
        });

    // Show help if no command is provided
    if (process.argv.length === 2) {
        program.outputHelp();
        console.log('\nExamples:');
        console.log('  ast-viz file test.py');
        console.log('  ast-viz file test.py -o ast-output.dot');
        console.log('  ast-viz code "x = 1 + 2"');
        console.log('  ast-viz code "print(\'hello\')" -o hello.dot');
        process.exit(0);
    }

    program.parse(process.argv);
}

// Run the CLI if this file is executed directly
if (require.main === module) {
    main();
}
