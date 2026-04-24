import { Context, type JitHooks } from "../../../engines/cse/context";
import { evaluate } from "../../../engines/cse/interpreter";
import { SVMLCompiler } from "../../../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../../../engines/svml/svml-interpreter";
import math from "../../../stdlib/math";
import memo from "../../../stdlib/memo";
import misc from "../../../stdlib/misc";
import { createDefaultWorklist, makeDfaQuery, makeJitDispatch } from "../../../specialization";
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

  const worklist = createDefaultWorklist(ast, environments);
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
  const dispatch = makeJitDispatch(worklist);
  const interpreter = new SVMLInterpreter(program, {
    sendOutput: msg => captured.push(msg),
    // Mirrors PySvmlJitEvaluator: always recompile via compileFunction,
    // passing the speculative body only when dispatch actually specialized.
    dispatchCall: (scopeId, args) => {
      const r = dispatch.onCall(scopeId, args);
      if (r === undefined) return undefined;
      const body = r.kind === "specialized" ? r.body : undefined;
      return compiler.compileFunction(r.unit, body);
    },
    dispatchReturn: dispatch.onReturn,
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
  const worklist = createDefaultWorklist(ast, environments);
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

/**
 * Run `code` through the CSE JIT pipeline. Mirrors
 * `PyCseJitEvaluator.evaluateChunk` without the conductor dependency.
 */
export async function runCseJit(code: string): Promise<string[]> {
  const script = code + "\n";
  const ast = parse(script);
  const { errors, environments } = analyzeWithEnvironments(ast, script, 3, [misc, math, memo]);
  if (errors.length > 0) throw errors[0];

  const worklist = createDefaultWorklist(ast, environments);
  worklist.drain();

  const dispatch = makeJitDispatch(worklist);
  const jitHooks: JitHooks = {
    rootScope: ast,
    dispatchCall: (scopeId, args) => {
      const r = dispatch.onCall(scopeId, args);
      return r?.kind === "specialized" ? r.body : undefined;
    },
    dispatchReturn: dispatch.onReturn,
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
