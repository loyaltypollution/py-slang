import { ConductorError } from "@sourceacademy/conductor/common";
import { StmtNS } from "../../ast-types";
import { RuntimeSourceError } from "../../errors";
import { ModuleContext, NativeStorage } from "../../types";

/** Capabilities injected by JIT-capable evaluators. Absent in plain runs.
 *
 *  `dispatchCall` is the atomic call-entry hook: it records the call
 *  boundary (LIFO push, hotness bump), publishes param observations that
 *  extend the speculation chain, and returns the body to execute — or
 *  `undefined` to signal "use the function's own body, no specialization."
 *
 *  `dispatchReturn` fires on call unwind. It attributes the return value as
 *  a runtime observation (feeds `returnKindNarrowing`) against the LIFO
 *  frame's chain (B1: the chain that actually held during this call), then
 *  pops the frame.
 *
 *  Per-call chain bookkeeping stays on the LIFO because return-kind
 *  observations need to attribute to the call being unwound, not to
 *  whatever the engine's global leaf has since moved to.
 */
export interface JitHooks {
  readonly rootScope: StmtNS.FileInput;
  dispatchCall(
    scopeId: number,
    args: readonly unknown[],
  ): ReadonlyArray<StmtNS.Stmt> | undefined;
  dispatchReturn(scopeId: number, value: unknown): void;
}

import { Control } from "./control";
import { Environment } from "./environment";
import { BuiltinValue, Stash } from "./stash";
import { ReadableContext, WritableContext } from "./streams";
import { Node } from "./types";

/**
 * Stores the global context of the CSE engine,
 * including the control and stash, as well as other relevant information
 * such as the environment tree and loaded modules. This context is passed around and mutated during the evaluation of a program.
 */
export class Context {
  public control: Control;
  public stash: Stash;

  public streams:
    | {
        initialised: false;
      }
    | {
        initialised: true;
        stdout: WritableContext<string>;
        stderr: WritableContext<ConductorError>;
        stdin: ReadableContext<string>;
      };
  public errors: RuntimeSourceError[] = [];
  public moduleContexts: { [name: string]: ModuleContext };
  public prelude: string | null = null;

  runtime: {
    break: boolean;
    debuggerOn: boolean;
    isRunning: boolean;
    environments: Environment[];
    nodes: Node[];
    control: Control | null;
    stash: Stash | null;
    objectCount: number;
    envStepsTotal: number;
    breakpointSteps: number[];
    changepointSteps: number[];
  };

  /** JIT capabilities. Wired by JIT-capable evaluators before `evaluate`;
   *  cleared afterward. `undefined` in plain (non-JIT) runs. */
  jitHooks?: JitHooks;

  /**
   * Used for storing the native context and other values
   */
  nativeStorage: NativeStorage;

  constructor(program?: StmtNS.Stmt) {
    this.control = new Control(program);
    this.stash = new Stash();
    this.runtime = this.createEmptyRuntime();
    this.moduleContexts = {};
    //this.environment = createProgramEnvironment(context || this, false);
    if (this.runtime.environments.length === 0) {
      const globalEnvironment = this.createGlobalEnvironment();
      this.runtime.environments.push(globalEnvironment);
    }
    this.streams = this.createEmptyStreams();
    this.nativeStorage = {
      builtins: new Map<string, BuiltinValue>(),
      maxExecTime: 1000,
      loadedModules: {},
      loadedModuleTypes: {},
    };
  }

  createGlobalEnvironment = (): Environment => ({
    tail: null,
    name: "global",
    head: {},
    id: "-1",
  });

  createEmptyRuntime = () => ({
    break: false,
    debuggerOn: true,
    isRunning: false,
    environments: [],
    value: undefined,
    nodes: [],
    control: null,
    stash: null,
    objectCount: 0,
    envSteps: -1,
    envStepsTotal: 0,
    breakpointSteps: [],
    changepointSteps: [],
  });

  createEmptyStreams = (): { initialised: false } => ({
    initialised: false,
  });

  public reset(program?: StmtNS.Stmt): void {
    this.control = new Control(program);
    this.stash = new Stash();
    //this.environment = createProgramEnvironment(this, false);
    this.errors = [];
  }

  public copy(): Context {
    const newContext = new Context();
    newContext.control = this.control.copy();
    newContext.stash = this.stash.copy();
    //newContext.environments = this.copyEnvironment(this.environments);
    return newContext;
  }

  private copyEnvironment(env: Environment): Environment {
    const newTail = env.tail ? this.copyEnvironment(env.tail) : null;
    const newEnv: Environment = {
      id: env.id,
      name: env.name,
      tail: newTail,
      head: { ...env.head },
      callExpression: env.callExpression,
      closure: env.closure,
    };
    return newEnv;
  }
}
