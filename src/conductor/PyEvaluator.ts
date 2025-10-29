import { runInContext } from "../runner/pyRunner";
import { BasicEvaluator } from "@sourceacademy/conductor/runner";

export default class PyEvaluator extends BasicEvaluator {

  async evaluateChunk(chunk: string): Promise<void> {
    try {
      const {result, stdout} = await runInContext(chunk);
      this.conductor.sendOutput(stdout);
    } catch (error) {
      this.conductor.sendOutput(
        `Error: ${error instanceof Error ? error.message : error}`
      );
    }
  }
}
