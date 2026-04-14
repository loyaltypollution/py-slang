import { ConductorError, ErrorType } from "@sourceacademy/conductor/common";
import { BasicEvaluator, IRunnerPlugin } from "@sourceacademy/conductor/runner";
import { Context } from "../engines/cse/context";
import { evaluate } from "../engines/cse/interpreter";
import {
  createErrorStream,
  createInputStream,
  createOutputStream,
  destroyStreams,
  displayError,
} from "../engines/cse/streams";
import { makeJitPass } from "../engines/svml/jit-pass";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  RUNTIME_CALL_COUNT_SAT,
  Worklist,
  observeRuntimeWrite,
  runtimeCallPass,
} from "../specialization";

/**
 * ⚠️ EXPERIMENTAL — NOT FOR PRODUCTION USE ⚠️
 *
 * Tiered JIT: races CSE and SVML against one shared Worklist. Winner's
 * buffered effects are flushed; loser is cooperatively aborted via an
 * `aborted` flag checked in observation callbacks and proxy input. Not
 * preemptive — an observe-free hot loop will block abort until it yields.
 *
 * Known soundness gap: both arms `await` inside their run loops, so the
 * event loop can interleave `wl.observe`, `wl.drain`, `wl.beginBatch`, and
 * `wl.endBatch` calls against the single shared `Worklist`. `batchDepth`,
 * `pendingRebuilds`, and `processQueue` are not re-entrant and carry no
 * locking. Concurrent `endBatch` calls can race the outermost-drain check;
 * mid-drain observations from the other arm can enqueue items into a
 * partially-drained queue. Deterministic under specific interleavings only.
 *
 * Use for research / benchmarking. Do not wire into the production
 * conductor registry.
 */

class AbortError extends Error { constructor() { super("aborted"); } }

type Buf = { out: string[]; err: ConductorError[]; res?: unknown };

function makeProxy(real: IRunnerPlugin, tape: string[], pending: { p?: Promise<void> }, flag: { aborted: boolean }): {
  proxy: IRunnerPlugin;
  buf: Buf;
} {
  const buf: Buf = { out: [], err: [] };
  let cursor = 0;
  const proxy = new Proxy(real, {
    get(t, prop, r) {
      switch (prop) {
        case "sendOutput": return (m: string) => { if (!flag.aborted) buf.out.push(m); };
        case "sendResult": return (v: unknown) => { if (!flag.aborted && !("res" in buf)) buf.res = v; };
        case "sendError":  return (e: ConductorError) => { if (!flag.aborted) buf.err.push(e); };
        case "requestInput": return async () => {
          while (cursor >= tape.length) {
            if (flag.aborted) throw new AbortError();
            pending.p ??= real.requestInput().then(v => { tape.push(v); pending.p = undefined; });
            await pending.p;
          }
          if (flag.aborted) throw new AbortError();
          return tape[cursor++];
        };
        case "tryRequestInput": return () => cursor < tape.length ? tape[cursor] : undefined;
      }
      return Reflect.get(t, prop, r);
    },
  }) as IRunnerPlugin;
  return { proxy, buf };
}

function flush(real: IRunnerPlugin, b: Buf): void {
  b.out.forEach(o => real.sendOutput(o));
  b.err.forEach(e => real.sendError(e));
  if ("res" in b) real.sendResult(b.res);
}

async function runCse(chunk: string, variant: number, wl: Worklist, c: IRunnerPlugin, flag: { aborted: boolean }): Promise<void> {
  const ctx = new Context();
  ctx.streams = {
    initialised: true,
    stdout: createOutputStream(c),
    stderr: createErrorStream(c),
    stdin: createInputStream(c),
  };
  try {
    const ast = parse(chunk + "\n");
    ctx.runtime.rootScope = ast;
    const calls = new Map<number, number>();
    ctx.runtime.observeNodeWrite = (id, v) => {
      if (flag.aborted) throw new AbortError();
      observeRuntimeWrite(wl, id, v);
    };
    ctx.runtime.observeScopeCall = id => {
      if (flag.aborted) throw new AbortError();
      const cur = calls.get(id) ?? 0;
      if (cur >= RUNTIME_CALL_COUNT_SAT) return;
      calls.set(id, cur + 1);
      wl.observe(runtimeCallPass, id, cur + 1);
      wl.drain();
    };
    wl.beginBatch();
    try {
      await evaluate("", ast, ctx, { variant, groups: [] });
    } finally {
      wl.endBatch();
      wl.drain();
      ctx.runtime.observeNodeWrite = undefined;
      ctx.runtime.observeScopeCall = undefined;
    }
  } catch (e) {
    if (e instanceof AbortError) return;
    const type = e instanceof SyntaxError ? ErrorType.EVALUATOR_SYNTAX : ErrorType.INTERNAL;
    await displayError(ctx, e, type);
  } finally {
    await destroyStreams(ctx);
  }
}

async function runSvml(
  ast: ReturnType<typeof parse>,
  envs: ReturnType<typeof analyzeWithEnvironments>["environments"],
  wl: Worklist,
  c: IRunnerPlugin,
  flag: { aborted: boolean },
): Promise<void> {
  try {
    const compiler = SVMLCompiler.fromProgramUnit(ast, envs, wl.units, wl.factStore, wl.nodeIndex);
    const program = compiler.compileProgram(ast);
    const calls = new Map<number, number>();
    const interp = new SVMLInterpreter(program, {
      sendOutput: c.sendOutput.bind(c),
      observeNodeWrite: (id, v) => {
        if (flag.aborted) throw new AbortError();
        observeRuntimeWrite(wl, id, v);
      },
      observeScopeCall: id => {
        if (flag.aborted) throw new AbortError();
        const cur = calls.get(id) ?? 0;
        if (cur >= RUNTIME_CALL_COUNT_SAT) return;
        calls.set(id, cur + 1);
        wl.observe(runtimeCallPass, id, cur + 1);
        wl.drain();
      },
    });
    wl.register(makeJitPass({ compiler, interpreter: interp, unitsOf: () => wl.units.values() }));
    wl.beginBatch();
    try {
      c.sendResult(SVMLInterpreter.toJSValue(await interp.execute()));
    } finally {
      wl.endBatch();
    }
  } catch (e) {
    if (!(e instanceof AbortError)) throw e;
  }
}

export class PyTieredJitEvaluator extends BasicEvaluator {
  constructor(conductor: IRunnerPlugin, private readonly variant = 4) {
    super(conductor);
  }

  async evaluateChunk(chunk: string): Promise<void> {
    let ast: ReturnType<typeof parse>;
    let envs: ReturnType<typeof analyzeWithEnvironments>["environments"];
    let wl: Worklist;
    try {
      const script = chunk + "\n";
      ast = parse(script);
      const a = analyzeWithEnvironments(ast, script, this.variant, []);
      if (a.errors.length > 0) throw a.errors[0];
      envs = a.environments;
      wl = new Worklist(ast, envs);
      wl.drain();
    } catch (e) {
      this.conductor.sendError(e as ConductorError);
      return;
    }

    const tape: string[] = [];
    const pending: { p?: Promise<void> } = {};
    const flag = { aborted: false };
    const cse = makeProxy(this.conductor, tape, pending, flag);
    const svml = makeProxy(this.conductor, tape, pending, flag);

    const winner = await Promise.race([
      runCse(chunk, this.variant, wl, cse.proxy, flag).then(() => cse.buf),
      runSvml(ast, envs, wl, svml.proxy, flag).then(() => svml.buf),
    ]);
    flag.aborted = true;
    flush(this.conductor, winner);
  }
}
