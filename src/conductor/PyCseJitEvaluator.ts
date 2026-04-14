import { ErrorType } from "@sourceacademy/conductor/common";
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
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  RUNTIME_CALL_COUNT_SAT,
  Worklist,
  observeRuntimeWrite,
  runtimeCallPass,
} from "../specialization";
import linkedList from "../stdlib/linked-list";
import list from "../stdlib/list";
import pairmutator from "../stdlib/pairmutator";
import parser from "../stdlib/parser";
import stream from "../stdlib/stream";
import { Group } from "../stdlib/utils";

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => (promise ??= fn());
}

abstract class PyCseJitEvaluatorBase extends BasicEvaluator {
  private context = new Context();
  private readonly variant: number;
  private readonly groups: Group[];
  private readonly ensurePreludesLoaded: () => Promise<void>;

  protected constructor(conductor: IRunnerPlugin, variant: number, groups: Group[]) {
    super(conductor);
    this.variant = variant;
    this.groups = groups;

    for (const group of this.groups) {
      for (const [name, value] of group.builtins) {
        this.context.nativeStorage.builtins.set(name, value);
      }
    }

    this.ensurePreludesLoaded = once(async () => {
      for (const group of this.groups) {
        if (group.prelude) {
          const ast = parse(group.prelude + "\n");
          await evaluate("", ast, this.context, {
            isPrelude: true,
            variant: this.variant,
            groups: [],
          });
        }
      }
    });
  }

  async evaluateChunk(chunk: string): Promise<void> {
    try {
      this.context.streams = {
        initialised: true,
        stdout: createOutputStream(this.conductor),
        stderr: createErrorStream(this.conductor),
        stdin: createInputStream(this.conductor),
      };

      await this.ensurePreludesLoaded();

      const script = chunk + "\n";
      const ast = parse(script);
      const { errors, environments } = analyzeWithEnvironments(
        ast,
        script,
        this.variant,
        this.groups,
      );

      if (errors.length > 0) {
        for (const error of errors.slice(0, -1)) {
          await displayError(this.context, error, ErrorType.EVALUATOR_SYNTAX);
        }
        throw errors[errors.length - 1];
      }

      const worklist = new Worklist(ast, environments);
      worklist.drain();

      this.context.runtime.rootScope = ast;
      // Per-callee raw counters live in the closure for this evaluation.
      const callCounts = new Map<number, number>();
      this.context.runtime.observeNodeWrite = (nodeId, value) => {
        observeRuntimeWrite(worklist, nodeId, value);
      };
      this.context.runtime.observeScopeCall = (scopeId) => {
        const cur = callCounts.get(scopeId) ?? 0;
        if (cur >= RUNTIME_CALL_COUNT_SAT) return;
        const next = cur + 1;
        callCounts.set(scopeId, next);
        worklist.observe(runtimeCallPass, scopeId, next);
        // Scope-call boundary: drain any writes buffered since the last call so
        // memoization / tier-up transforms can fire before the next invocation.
        // Gated on pending work to skip empty drains once facts have saturated.
        if (worklist.hasPendingWork()) worklist.drain();
      };

      worklist.beginBatch();
      try {
        await evaluate("", ast, this.context, {
          variant: this.variant,
          groups: this.groups,
        });
      } finally {
        worklist.endBatch();
        worklist.drain();
        this.context.runtime.observeNodeWrite = undefined;
        this.context.runtime.observeScopeCall = undefined;
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        await displayError(this.context, e, ErrorType.EVALUATOR_SYNTAX);
        return;
      }
      await displayError(this.context, e, ErrorType.INTERNAL);
    } finally {
      await destroyStreams(this.context);
    }
  }
}

export class PyCseJitEvaluator1 extends PyCseJitEvaluatorBase {
  constructor(conductor: IRunnerPlugin) {
    super(conductor, 1, []);
  }
}

export class PyCseJitEvaluator2 extends PyCseJitEvaluatorBase {
  constructor(conductor: IRunnerPlugin) {
    super(conductor, 2, [linkedList]);
  }
}

export class PyCseJitEvaluator3 extends PyCseJitEvaluatorBase {
  constructor(conductor: IRunnerPlugin) {
    super(conductor, 3, [linkedList, list, pairmutator, stream]);
  }
}

export class PyCseJitEvaluator4 extends PyCseJitEvaluatorBase {
  constructor(conductor: IRunnerPlugin) {
    super(conductor, 4, [linkedList, list, pairmutator, stream, parser]);
  }
}
