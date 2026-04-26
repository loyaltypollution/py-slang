import { StmtNS } from "../../../ast-types";
import { SVMLCompiler } from "../../../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../../../engines/svml/svml-interpreter";
import type { SVMLProgram } from "../../../engines/svml/types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments, type FunctionEnvironments } from "../../../resolver";
import { constAnalysis, typeAnalysis } from "../../../specialization/analysis";
import { ROOT_CONTEXT } from "../../../specialization/assumption/chain";
import { Worklist } from "../../../specialization/framework/worklist";
import math from "../../../stdlib/math";
import memo from "../../../stdlib/memo";
import misc from "../../../stdlib/misc";
import { buildTestWorklist } from "../../utils";

const CHAPTER = 4;
const GROUPS = [misc, math, memo];

interface DfaQuery {
  typeOf(id: number): ReturnType<ReturnType<typeof typeAnalysis.perExpr>["tryRead"]>;
  constOf(id: number): ReturnType<ReturnType<typeof constAnalysis.perExpr>["tryRead"]>;
}

type WorklistConfig = ConstructorParameters<typeof Worklist>[0];

function dfaQueryFor(worklist: Worklist): DfaQuery {
  const typeStore = typeAnalysis.perExpr(worklist.locate);
  const constStore = constAnalysis.perExpr(worklist.locate);

  return {
    typeOf(id: number) {
      return typeStore.tryRead(id, ROOT_CONTEXT);
    },
    constOf(id: number) {
      return constStore.tryRead(id, ROOT_CONTEXT);
    },
  };
}

export interface Setup {
  ast: StmtNS.FileInput;
  environments: FunctionEnvironments;
  worklist: Worklist;
}

/** Parse + resolve + build worklist. Does not drain. */
export function setup(code: string): Setup {
  const script = code + "\n";
  const ast = parse(script);
  const { errors, environments } = analyzeWithEnvironments(ast, script, CHAPTER, GROUPS);
  if (errors.length > 0) throw errors[0];

  const worklist = buildTestWorklist(ast, environments);
  return { ast, environments, worklist };
}

/** Parse + resolve + build worklist + drain to fixed point. */
export function setupAndDrain(code: string): Setup {
  const result = setup(code);
  result.worklist.drain();
  return result;
}

/** Parse + resolve + build a worklist with a caller-supplied analysis set
 *  (bypasses DEFAULT_PASSES). Use when the test wants to exercise a specific
 *  DFA in isolation or wire a synthetic analysis. */
export function setupWithAnalyses(code: string, analyses: WorklistConfig["analyses"]): Setup {
  const script = code + "\n";
  const ast = parse(script);
  const { errors, environments } = analyzeWithEnvironments(ast, script, CHAPTER, GROUPS);
  if (errors.length > 0) throw errors[0];

  const worklist = new Worklist({
    ast,
    functionEnvironments: environments,
    analyses,
    transforms: [],
  });

  return { ast, environments, worklist };
}

export function compileOptimized(code: string): SVMLProgram {
  const { ast, environments, worklist } = setupAndDrain(code);
  const compiler = SVMLCompiler.fromProgramUnit(ast, environments, dfaQueryFor(worklist));
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
  const interpreter = new SVMLInterpreter(program, {
    sendOutput(message: string): void {
      outputs.push(message);
    },
  });
  const raw = interpreter.execute();
  return { value: SVMLInterpreter.toJSValue(raw), stdout: outputs.join("\n") };
}
