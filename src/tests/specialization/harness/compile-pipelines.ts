import { StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments, type FunctionEnvironments } from "../../../resolver";
import { SVMLCompiler } from "../../../engines/svml/svml-compiler";
import { makeDfaQuery } from "../../../specialization";
import { SVMLInterpreter } from "../../../engines/svml/svml-interpreter";
import type { SVMLProgram } from "../../../engines/svml/types";
import type { Analysis } from "../../../specialization/framework/analysis";
import type { ObservationChannel } from "../../../specialization/assumption/observation-channel";
import { Worklist } from "../../../specialization/framework/worklist";
import math from "../../../stdlib/math";
import memo from "../../../stdlib/memo";
import misc from "../../../stdlib/misc";
import { buildTestWorklist } from "../../utils";

const CHAPTER = 4;
const GROUPS = [misc, math, memo];

export interface Setup {
  ast: StmtNS.FileInput;
  environments: FunctionEnvironments;
  worklist: Worklist;
}

/** Parse + resolve + build worklist. Does not drain. */
export function setup(code: string): Setup {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { errors, environments } = analyzeWithEnvironments(ast, script, CHAPTER, GROUPS);
  if (errors.length > 0) throw errors[0];
  const worklist = buildTestWorklist(ast, environments);
  return { ast, environments, worklist };
}

/** Parse + resolve + build worklist + drain to fixed point. */
export function setupAndDrain(code: string): Setup {
  const s = setup(code);
  s.worklist.drain();
  return s;
}

/** Parse + resolve + build a worklist with a caller-supplied analysis set
 *  (bypasses DEFAULT_PASSES). Use when the test wants to exercise a specific
 *  DFA in isolation or wire a synthetic analysis. */
export function setupWithAnalyses(
  code: string,
  analyses: ReadonlyArray<Analysis<any, any>>,
  options: { channels?: ReadonlyArray<ObservationChannel<any, any>> } = {},
): Setup {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { errors, environments } = analyzeWithEnvironments(ast, script, CHAPTER, GROUPS);
  if (errors.length > 0) throw errors[0];
  const worklist = new Worklist(
    ast,
    environments,
    analyses,
    undefined,
    [],
    [],
    [],
    options.channels ?? [],
  );
  return { ast, environments, worklist };
}

export function compileOptimized(code: string): SVMLProgram {
  const { ast, environments, worklist } = setupAndDrain(code);
  const compiler = SVMLCompiler.fromProgramUnit(
    ast,
    environments,
    makeDfaQuery(worklist.topology),
    worklist.registry,
  );
  return compiler.compileProgram(ast);
}

export function compileUnoptimized(code: string): SVMLProgram {
  const { ast, environments } = setup(code);
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
