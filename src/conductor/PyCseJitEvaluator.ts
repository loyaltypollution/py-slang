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
import { Worklist, makeJitObservers } from "../specialization";
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

      const worklist = new Worklist(ast, environments);
      worklist.drain();

      this.context.runtime.rootScope = ast;
      const observers = makeJitObservers(worklist);
      this.context.runtime.observeNodeWrite = observers.observeNodeWrite;
      this.context.runtime.observeScopeCall = observers.observeScopeCall;

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
