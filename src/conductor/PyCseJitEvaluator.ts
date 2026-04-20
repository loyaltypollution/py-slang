import { ErrorType } from "@sourceacademy/conductor/common";
import { IRunnerPlugin } from "@sourceacademy/conductor/runner";
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
import { StmtNS } from "../ast-types";
import type { AssumptionChain } from "../specialization/framework/context";
import type { JitHooks } from "../engines/cse/context";
import type { Unit } from "../specialization/framework/function-unit";
import {
  DEFAULT_PASSES,
  DEFAULT_TRANSFORMS,
  Worklist,
} from "../specialization/framework/worklist";
import { memoizationRule } from "../specialization/transforms/memoization";
import { makeJitObservers, specializedBodyFor } from "../specialization";
import linkedList from "../stdlib/linked-list";
import list from "../stdlib/list";
import pairmutator from "../stdlib/pairmutator";
import parser from "../stdlib/parser";
import stream from "../stdlib/stream";
import { PyCseEvaluatorBase } from "./PyCseEvaluator";

const NO_CLONE = Symbol("no-clone");
type CachedBody = ReadonlyArray<StmtNS.Stmt> | typeof NO_CLONE;

// CSE's clone lane publishes only ephemeral specialized bodies at call-entry.
// Shared-AST memoization is a different publication contract (structural
// mutation of `fd.body`), so exclude that transform from this path.
const CSE_JIT_TRANSFORMS = DEFAULT_TRANSFORMS.filter(rule => rule !== memoizationRule);

abstract class PyCseJitEvaluatorBase extends PyCseEvaluatorBase {
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

      const worklist = new Worklist(ast, environments, DEFAULT_PASSES, undefined, CSE_JIT_TRANSFORMS);
      worklist.drain();

      const observers = makeJitObservers(worklist);
      // Cache clones by (unit, AssumptionChain) reference. Chains are canonical
      // via the interner, so reference equality is enough; stale entries for
      // retired chains are simply never read.
      // CSE's speculative clone lane is entry-guarded only: per-node write
      // observations are not wired here because they would pollute the unit's
      // active context with non-entry assumptions and block cloned-body selection.
      const cloneCache = new Map<Unit, Map<AssumptionChain, CachedBody>>();
      const jitHooks: JitHooks = {
        rootScope: ast,
        observeScopeCall: observers.observeScopeCall,
        observeParamEntry: observers.observeParamEntry,
        specializedFunctionBodyFor: (scopeId: number) => {
          const unit = worklist.topology.unitOfFunctionId(scopeId);
          if (unit === undefined) return undefined;
          const ctx = worklist.specAssumptionChainFor(unit);
          let perCtx = cloneCache.get(unit);
          if (perCtx === undefined) {
            perCtx = new Map();
            cloneCache.set(unit, perCtx);
          }
          const hit = perCtx.get(ctx);
          if (hit !== undefined) return hit === NO_CLONE ? undefined : hit;
          const body = specializedBodyFor(unit, ctx, worklist.topology);
          perCtx.set(ctx, body ?? NO_CLONE);
          return body;
        },
      };
      this.context.jitHooks = jitHooks;

      try {
        await evaluate("", ast, this.context, {
          variant: this.variant,
          groups: this.groups,
        });
        worklist.drain();
      } finally {
        this.context.jitHooks = undefined;
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
