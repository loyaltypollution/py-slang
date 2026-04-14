import type { Environment } from "../../resolver";
import type { Token } from "../../tokenizer";

export interface SlotInfo {
  slot: number;
  envLevel: number;
  isPrimitive: boolean;
}

export type SlotLookup = (token: Token) => SlotInfo;

/** A slot is "local" iff it's a real variable (not a primitive binding) at the
 *  current function's envLevel. Shared across const/type/purity analyses and
 *  block-transfer's assignment-effect filter. */
export function isLocal(info: SlotInfo): boolean {
  return !info.isPrimitive && info.envLevel === 0;
}

/** Build a SlotLookup. Params → 0..n-1, locals → n..m; non-locals resolve via env chain. */
export function buildSlotTable(env: Environment, paramNames: string[]): SlotLookup {
  const slots = new Map<string, SlotInfo>();

  for (let i = 0; i < paramNames.length; i++) {
    slots.set(paramNames[i], { slot: i, envLevel: 0, isPrimitive: false });
  }

  let nextSlot = paramNames.length;
  for (const name of env.names.keys()) {
    if (!slots.has(name)) {
      slots.set(name, { slot: nextSlot++, envLevel: 0, isPrimitive: false });
    }
  }

  return (token: Token): SlotInfo => {
    const name = token.lexeme;

    const local = slots.get(name);
    if (local) return local;

    const declaringEnv = env.lookupNameEnvByString(name);
    if (declaringEnv === null) {
      // Memoization intrinsics are injected post-resolution; treat as primitives.
      if (name.startsWith("__memo_")) {
        return { slot: -1, envLevel: 0, isPrimitive: true };
      }
      throw new Error(`Variable ${name} not found in environment`);
    }

    // Outermost env = primitive.
    if (declaringEnv.enclosing === null) {
      return { slot: -1, envLevel: 0, isPrimitive: true };
    }

    const envLevel = env.lookupNameByString(name);
    return { slot: 0, envLevel, isPrimitive: false };
  };
}
