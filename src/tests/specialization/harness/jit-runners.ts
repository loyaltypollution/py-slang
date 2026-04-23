import { Context, type JitHooks } from "../../../engines/cse/context";
import { evaluate } from "../../../engines/cse/interpreter";
import { SVMLCompiler } from "../../../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../../../engines/svml/svml-interpreter";
import math from "../../../stdlib/math";
import memo from "../../../stdlib/memo";
import misc from "../../../stdlib/misc";
import { makeDfaQuery, makeJitObservers } from "../../../specialization";
import { DEFAULT_PASSES, DEFAULT_TRANSFORMS } from "../../../specialization/defaults";
import { bodyToCompile, dispatchValid } from "../../../specialization/framework/dispatch";
import { Worklist } from "../../../specialization/framework/worklist";
import { memoizationRule } from "../../../specialization/transforms/memoization";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";

/**
 * Run `code` through the SVML JIT pipeline (live per-call specialization via
 * dispatchCall). Mirrors `PySvmlJitEvaluator.evaluateChunk` without the
 * conductor dependency; stdout is captured via `sendOutput`.
 */
export async function runSvmlJit(code: string): Promise<string[]> {
  const script = code + "\n";
  const ast = parse(script);
  const { errors, environments } = analyzeWithEnvironments(ast, script, 4, [misc, math, memo]);
  if (errors.length > 0) throw errors[0];

  const worklist = new Worklist(ast, environments, DEFAULT_PASSES, undefined, DEFAULT_TRANSFORMS);
  worklist.drain();

  const compiler = SVMLCompiler.fromProgramUnit(
    ast,
    environments,
    makeDfaQuery(
      worklist.topology,
      id => worklist.futureDispatchChainForNode(id),
      u => worklist.futureDispatchChainFor(u),
    ),
    worklist.registry,
  );
  const program = compiler.compileProgram(ast);

  const captured: string[] = [];
  const observers = makeJitObservers(worklist);
  const interpreter = new SVMLInterpreter(program, {
    sendOutput: msg => captured.push(msg),
    dispatchCall: (scopeId, args) => {
      observers.observeScopeCall(scopeId);
      const unit = worklist.topology.unitOfFunctionId(scopeId);
      if (unit === undefined) return undefined;
      for (let i = 0; i < args.length; i++) observers.observeParamEntry(scopeId, i, args[i]);
      worklist.sweepTransforms();
      const chain = observers.currentChainFor(scopeId);
      const isRetired = (n: Parameters<typeof worklist.isRetired>[0]) => worklist.isRetired(n);
      if (!dispatchValid(unit, chain, isRetired)) return undefined;
      const body = bodyToCompile(unit, chain, worklist.topology, isRetired);
      if (body === unit.body) return undefined;
      return compiler.compileFunction(unit, body);
    },
    dispatchReturn: (scopeId, value) => observers.observeScopeReturn(scopeId, value),
  });
  await interpreter.execute();
  return captured;
}

/**
 * Run `code` through the SVML pipeline WITHOUT JIT dispatch — body selection
 * is locked to the baseline (unspecialized) bytecode. Ground truth for
 * JIT-regression tests.
 */
export async function runSvmlNoJit(code: string): Promise<string[]> {
  const script = code + "\n";
  const ast = parse(script);
  const { errors, environments } = analyzeWithEnvironments(ast, script, 4, [misc, math, memo]);
  if (errors.length > 0) throw errors[0];
  const worklist = new Worklist(ast, environments, DEFAULT_PASSES, undefined, DEFAULT_TRANSFORMS);
  const compiler = SVMLCompiler.fromProgramUnit(
    ast,
    environments,
    makeDfaQuery(
      worklist.topology,
      id => worklist.futureDispatchChainForNode(id),
      u => worklist.futureDispatchChainFor(u),
    ),
    worklist.registry,
  );
  const program = compiler.compileProgram(ast);
  const captured: string[] = [];
  const interp = new SVMLInterpreter(program, { sendOutput: m => captured.push(m) });
  await interp.execute();
  return captured;
}

// Memoization is excluded because CSE runs live-per-call and doesn't need it.
const CSE_JIT_TRANSFORMS = DEFAULT_TRANSFORMS.filter(r => r !== memoizationRule);

/**
 * Run `code` through the CSE JIT pipeline. Mirrors
 * `PyCseJitEvaluator.evaluateChunk` without the conductor dependency.
 */
export async function runCseJit(code: string): Promise<string[]> {
  const script = code + "\n";
  const ast = parse(script);
  const { errors, environments } = analyzeWithEnvironments(ast, script, 3, [misc, math, memo]);
  if (errors.length > 0) throw errors[0];

  const worklist = new Worklist(ast, environments, DEFAULT_PASSES, undefined, CSE_JIT_TRANSFORMS);
  worklist.drain();

  const observers = makeJitObservers(worklist);
  const jitHooks: JitHooks = {
    rootScope: ast,
    dispatchCall: (scopeId, args) => {
      observers.observeScopeCall(scopeId);
      const unit = worklist.topology.unitOfFunctionId(scopeId);
      if (unit === undefined) return undefined;
      for (let i = 0; i < args.length; i++) observers.observeParamEntry(scopeId, i, args[i]);
      const chain = observers.currentChainFor(scopeId);
      const isRetired = (n: Parameters<typeof worklist.isRetired>[0]) => worklist.isRetired(n);
      if (!dispatchValid(unit, chain, isRetired)) return undefined;
      const body = bodyToCompile(unit, chain, worklist.topology, isRetired);
      return body === unit.body ? undefined : body;
    },
    dispatchReturn: (scopeId, value) => observers.observeScopeReturn(scopeId, value),
  };

  const captured: string[] = [];
  const context = new Context();
  const outStream = new WritableStream<string>({ write: chunk => { captured.push(chunk); } });
  const errStream = new WritableStream<unknown>({ write: () => {} });
  const inStream = new ReadableStream<string>({});
  context.streams = {
    initialised: true,
    stdout: { stream: outStream, writer: outStream.getWriter() },
    stderr: { stream: errStream, writer: errStream.getWriter() },
    stdin: { stream: inStream, reader: inStream.getReader() },
  };
  context.jitHooks = jitHooks;
  for (const group of [misc, math, memo]) {
    for (const [name, value] of group.builtins) {
      context.nativeStorage.builtins.set(name, value);
    }
  }

  try {
    await evaluate("", ast, context, { variant: 3, groups: [] });
    worklist.drain();
  } finally {
    context.jitHooks = undefined;
  }

  return captured;
}
