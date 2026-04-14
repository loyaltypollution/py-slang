import { parse } from "../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../resolver";
import { SVMLCompiler } from "../../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../../engines/svml/svml-interpreter";
import type { SVMLProgram } from "../../engines/svml/types";
import { buildTestWorklist } from "../utils";

const CHAPTER = 4;

export function compileOptimized(code: string): SVMLProgram {
  const script = code + "\n";
  const ast = parse(script);
  const { errors, environments } = analyzeWithEnvironments(ast, script, CHAPTER);
  if (errors.length > 0) throw errors[0];
  const engine = buildTestWorklist(ast, environments);
  engine.drain();
  const compiler = SVMLCompiler.fromProgramUnit(ast, environments, engine.units, engine.factStore);
  return compiler.compileProgram(ast);
}

export function compileUnoptimized(code: string): SVMLProgram {
  const script = code + "\n";
  const ast = parse(script);
  const { errors, environments } = analyzeWithEnvironments(ast, script, CHAPTER);
  if (errors.length > 0) throw errors[0];
  const compiler = SVMLCompiler.fromProgram(ast, environments);
  return compiler.compileProgram(ast);
}

export interface RunResult {
  value: unknown;
  stdout: string;
}

export function runSvml(program: SVMLProgram): RunResult {
  const outputs: string[] = [];
  const interpreter = new SVMLInterpreter(program, { sendOutput: msg => outputs.push(msg) });
  const raw = interpreter.execute();
  return { value: SVMLInterpreter.toJSValue(raw), stdout: outputs.join("\n") };
}
