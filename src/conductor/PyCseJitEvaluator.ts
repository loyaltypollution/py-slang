import { ErrorType } from "@sourceacademy/conductor/common";
import { IRunnerPlugin } from "@sourceacademy/conductor/runner";
import type { JitHooks } from "../engines/cse/context";
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
import { makeJitObservers } from "../specialization";
import { DEFAULT_PASSES, DEFAULT_TRANSFORMS } from "../specialization/defaults";
import { bodyToCompile, dispatchValid } from "../specialization/framework/dispatch";
import { Worklist } from "../specialization/framework/worklist";
import linkedList from "../stdlib/linked-list";
import list from "../stdlib/list";
import pairmutator from "../stdlib/pairmutator";
import parser from "../stdlib/parser";
import stream from "../stdlib/stream";
import { PyCseEvaluatorBase } from "./PyCseEvaluator";

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

      const worklist = new Worklist(ast, environments, DEFAULT_PASSES, undefined, DEFAULT_TRANSFORMS);
      worklist.drain();

      const observers = makeJitObservers(worklist);
      // CSE's specialization is live-per-call: body selection re-derives
      // pruning at the current (post-param-observation) chain each call.
      const jitHooks: JitHooks = {
        rootScope: ast,
        dispatchCall: (scopeId, args) => {
          observers.observeScopeCall(scopeId);
          const unit = worklist.topology.unitOfFunctionId(scopeId);
          if (unit === undefined) return undefined;
          for (let i = 0; i < args.length; i++) {
            observers.observeParamEntry(scopeId, i, args[i]);
          }
          // Fire transforms before reading the body: `Worklist.bump` and
          // `publish` drive analyses to fixpoint but deliberately skip the
          // transform sweep (see `bump` guard). Without this call, the
          // memoization rule (and other runtime-counter- or purity-gated
          // transforms) stays dirty-but-unrun until the post-evaluate drain,
          // meaning the CSE interpreter would re-walk the unrewritten body
          // on every recursive call. Symmetric with SVML JIT's dispatchCall.
          worklist.sweepTransforms();
          const chain = observers.currentChainFor(scopeId);
          const isRetired = (n: Parameters<typeof worklist.isRetired>[0]) => worklist.isRetired(n);
          if (!dispatchValid(unit, chain, isRetired)) return undefined;
          const body = bodyToCompile(unit, chain, worklist.topology, isRetired);
          return body === unit.body ? undefined : body;
        },
        dispatchReturn: (scopeId, value) => {
          observers.observeScopeReturn(scopeId, value);
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
