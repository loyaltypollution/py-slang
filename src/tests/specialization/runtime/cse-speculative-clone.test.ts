import { Context, type JitHooks } from "../../../engines/cse/context";
import { evaluate } from "../../../engines/cse/interpreter";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import { makeJitObservers, specializedBodyFor } from "../../../specialization";
import {
  DEFAULT_PASSES,
  DEFAULT_TRANSFORMS,
  Worklist,
} from "../../../specialization/framework/worklist";
import { memoizationRule } from "../../../specialization/transforms/memoization";

function makeCaptureStreams(outputs: string[]) {
  const stdoutStream = new WritableStream<string>({
    write: chunk => {
      outputs.push(chunk);
    },
  });
  const stderrStream = new WritableStream<unknown>({
    write: _chunk => undefined,
  });
  const stdinStream = new ReadableStream<string>({
    pull: controller => controller.close(),
  });
  return {
    initialised: true as const,
    stdout: { stream: stdoutStream, writer: stdoutStream.getWriter() },
    stderr: { stream: stderrStream, writer: stderrStream.getWriter() },
    stdin: { stream: stdinStream, reader: stdinStream.getReader() },
  };
}

const CSE_JIT_TRANSFORMS = DEFAULT_TRANSFORMS.filter(rule => rule !== memoizationRule);

describe("CSE JIT evaluator hooks: speculative cloned bodies", () => {
  test("same-call param observation makes a specialized clone visible at call entry", async () => {
    const code = `
def hot(x):
    if x <= 0:
        print("no collatz here")
        return -1
    return 1

print(hot(5))
print(hot(0))
`;
    const script = code + "\n";
    const ast = parse(script);
    const { environments } = analyzeWithEnvironments(ast, script, 4);
    const worklist = new Worklist(ast, environments, DEFAULT_PASSES, undefined, CSE_JIT_TRANSFORMS);
    worklist.drain();

    const outputs: string[] = [];
    const context = new Context();
    context.streams = makeCaptureStreams(outputs);
    const observers = makeJitObservers(worklist);
    const hotId = (ast.statements[0] as any).id as number;
    const specializedSeenAtCallEntry: number[] = [];
    context.jitHooks = {
      rootScope: ast,
      observeScopeCall: observers.observeScopeCall,
      observeParamEntry: observers.observeParamEntry,
      specializedFunctionBodyFor: (scopeId: number) => {
        const unit = worklist.topology.unitOfFunctionId(scopeId);
        const body = unit === undefined
          ? undefined
          : specializedBodyFor(unit, worklist.specAssumptionChainFor(unit), worklist.topology);
        if (scopeId === hotId && body !== undefined) specializedSeenAtCallEntry.push(scopeId);
        return body;
      },
    } satisfies JitHooks;

    await evaluate("", ast, context, { variant: 4, groups: [] });
    worklist.drain();

    expect(specializedSeenAtCallEntry.length).toBeGreaterThan(0);
    expect(outputs.filter(x => x === "no collatz here")).toEqual(["no collatz here"]);
    expect(outputs.filter(x => x === "1")).toEqual(["1"]);
    expect(outputs.filter(x => x === "-1")).toEqual(["-1"]);
  });
});
