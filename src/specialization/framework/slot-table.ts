import type { Environment } from "../../resolver";
import type { Token } from "../../tokenizer";

export interface SlotInfo {
  slot: number;
  envLevel: number;
  isPrimitive: boolean;
}

export type SlotLookup = (token: Token) => SlotInfo;

/**
 * Build a SlotLookup for a function scope.
 *
 * Parameters get slots 0..n-1, remaining local variables get n..m.
 * Non-local variables are resolved via the environment chain at lookup time
 * (the DFA treats them as TOP; the compiler handles them independently).
 */
export function buildSlotTable(
  env: Environment,
  paramNames: string[],
): SlotLookup {
  const slots = new Map<string, SlotInfo>();

  // Parameters: slots 0..n-1
  for (let i = 0; i < paramNames.length; i++) {
    slots.set(paramNames[i], { slot: i, envLevel: 0, isPrimitive: false });
  }

  // Remaining local names from env.names (declaration order)
  let nextSlot = paramNames.length;
  for (const name of env.names.keys()) {
    if (!slots.has(name)) {
      slots.set(name, { slot: nextSlot++, envLevel: 0, isPrimitive: false });
    }
  }

  return (token: Token): SlotInfo => {
    const name = token.lexeme;

    // Fast path: local variable
    const local = slots.get(name);
    if (local) return local;

    // Non-local: walk environment chain
    const declaringEnv = env.lookupNameEnvByString(name);
    if (declaringEnv === null) {
      throw new Error(`Variable ${name} not found in environment`);
    }

    // Primitive: outermost env (enclosing === null)
    if (declaringEnv.enclosing === null) {
      return { slot: -1, envLevel: 0, isPrimitive: true };
    }

    // Non-local user variable: DFA returns TOP for envLevel > 0
    const envLevel = env.lookupNameByString(name);
    return { slot: 0, envLevel, isPrimitive: false };
  };
}
