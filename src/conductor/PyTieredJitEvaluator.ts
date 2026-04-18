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
import { SpeculationViolation } from "../engines/svml/errors";
import { makeJitAnalysis } from "../engines/svml/jit-analysis";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  Worklist,
  makeJitObservers,
  makeDfaQuery,
  blacklistSpeculation,
} from "../specialization";

const MAX_DEOPT_RETRIES = 32;

/** Races CSE and SVML on a shared Worklist; winner's buffered I/O is flushed, loser is aborted.
 *  Shared Worklist is safe across arms because all wl.* calls are synchronous and JS is
 *  single-threaded; batch composition defers drains, which monotone lattices tolerate. */

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
    const observers = makeJitObservers(wl, () => {
      if (flag.aborted) throw new AbortError();
    });
    ctx.runtime.observeNodeWrite = observers.observeNodeWrite;
    ctx.runtime.observeScopeCall = observers.observeScopeCall;
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
    const compiler = SVMLCompiler.fromProgramUnit(
      ast,
      envs,
      makeDfaQuery(wl.factStore, wl.nodeIndex),
      wl.registry,
    );
    const program = compiler.compileProgram(ast);
    const interp = new SVMLInterpreter(program, {
      sendOutput: c.sendOutput.bind(c),
      ...makeJitObservers(wl, () => {
        if (flag.aborted) throw new AbortError();
      }),
    });
    wl.register(makeJitAnalysis({ compiler, interpreter: interp }));
    wl.beginBatch();
    try {
      c.sendResult(SVMLInterpreter.toJSValue(await runSvmlWithDeopt(interp, wl)));
    } finally {
      wl.endBatch();
    }
  } catch (e) {
    if (!(e instanceof AbortError)) throw e;
  }
}

/** See PySvmlJitEvaluator.runWithDeopt — same protocol, duplicated to keep
 *  the AbortError plumbing local to this file. Aborts (race-loser signal)
 *  propagate; SpeculationViolation triggers widen + recompile + retry. */
async function runSvmlWithDeopt(
  interp: SVMLInterpreter,
  wl: Worklist,
): Promise<Awaited<ReturnType<SVMLInterpreter["execute"]>>> {
  let attempts = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await interp.execute();
    } catch (e) {
      if (e instanceof AbortError) throw e;
      if (!(e instanceof SpeculationViolation)) throw e;
      if (++attempts > MAX_DEOPT_RETRIES) {
        throw new Error(
          `JIT deopt budget exhausted (${MAX_DEOPT_RETRIES}); last violation at node ${e.nodeId} (${e.witnessedKind})`,
        );
      }
      blacklistSpeculation(wl, e.nodeId);
      wl.drain();
    }
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
