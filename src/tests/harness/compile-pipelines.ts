import { parse } from "../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../resolver";
import { SVMLCompiler } from "../../engines/svml/svml-compiler";
import { makeDfaQuery } from "../../specialization";
import { SVMLInterpreter } from "../../engines/svml/svml-interpreter";
import type { SVMLProgram } from "../../engines/svml/types";
import math from "../../stdlib/math";
import memo from "../../stdlib/memo";
import misc from "../../stdlib/misc";
import { buildTestWorklist } from "../utils";

const CHAPTER = 4;
const GROUPS = [misc, math, memo];

export function compileOptimized(code: string): SVMLProgram {
  const script = code + "\n";
  const ast = parse(script);
  const { errors, environments } = analyzeWithEnvironments(ast, script, CHAPTER, GROUPS);
  if (errors.length > 0) throw errors[0];
  const engine = buildTestWorklist(ast, environments);
  engine.drain();
  const compiler = SVMLCompiler.fromProgramUnit(
    ast,
    environments,
    makeDfaQuery(engine.topology),
    engine.registry,
  );
  return compiler.compileProgram(ast);
}

export function compileUnoptimized(code: string): SVMLProgram {
  const script = code + "\n";
  const ast = parse(script);
  const { errors, environments } = analyzeWithEnvironments(ast, script, CHAPTER, GROUPS);
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
