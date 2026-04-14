import { ErrorType } from "@sourceacademy/conductor/common";
import { BasicEvaluator, IRunnerPlugin } from "@sourceacademy/conductor/runner";
import { StmtNS } from "../ast-types";
import { Context, NULL_SINK } from "../engines/cse/context";
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
  Db,
  astOf,
  environmentsOf,
  runtimeCall,
  runtimeWrite,
  shouldMemoize,
} from "../specialization/runtime";
import { applyMemoizeInPlace } from "../specialization/transforms/mutate-memoize";
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
  protected db: Db = new Db();
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
      this.db = new Db();
      astOf.set(this.db, 0, ast);
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

      environmentsOf.set(this.db, 0, environments);

      // scopeId → FunctionDef lookup for tier-up. Rebuilt per chunk since
      // env identities are chunk-scoped. Lambda/MultiLambda are skipped:
      // memoize only wraps FunctionDef (see mutate-memoize.ts).
      const fdByScope = new Map<number, StmtNS.FunctionDef>();
      for (const key of environments.keys()) {
        if (key instanceof StmtNS.FunctionDef) fdByScope.set(key.id, key);
      }
      const memoized = new WeakSet<StmtNS.FunctionDef>();

      this.context.runtime.rootScope = ast;
      const callCounts = new Map<number, number>();
      const db = this.db;
      this.context.runtime.observeNodeWrite = (nodeId, value) => {
        runtimeWrite.set(db, nodeId, value);
      };
      this.context.runtime.observeScopeCall = (scopeId) => {
        const next = (callCounts.get(scopeId) ?? 0) + 1;
        callCounts.set(scopeId, next);
        runtimeCall.set(db, scopeId, next);

        // Tier-up: if the call-count / purity facts now say this scope
        // should memoize, wrap its body in place. Safe mid-run because
        // CSE re-reads `fd.body` at every call-entry (LBD contract,
        // src/engines/cse/interpreter.ts:1105). `applyMemoizeInPlace`
        // is idempotent via the `memoized` WeakSet.
        const fd = fdByScope.get(scopeId);
        if (fd !== undefined && !memoized.has(fd) && db.get(shouldMemoize, scopeId)) {
          applyMemoizeInPlace(fd, memoized);
        }
      };

      try {
        await evaluate("", ast, this.context, {
          variant: this.variant,
          groups: this.groups,
        });
      } finally {
        this.context.runtime.observationSink = NULL_SINK;
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
