import type { Environment } from "../../../resolver";
import type { Token } from "../../../tokenizer";

export interface SlotInfo {
  slot: number;
  envLevel: number;
  isPrimitive: boolean;
  /** Name is declared at module scope (one step inside the built-in
   *  scope). Module globals can be rebound between calls — their reads
   *  are impure, unlike closure captures. */
  isModuleGlobal: boolean;
}

/** Callable: token → SlotInfo. Also carries `slotCount` — the number of
 *  local slots (parameters + other locals). Analyses that need to
 *  enumerate every slot at a program point read this directly. */
export type SlotLookup = ((token: Token) => SlotInfo) & { readonly slotCount: number };

/** A slot is "local" iff it's a real variable (not a primitive binding)
 *  at the current function's envLevel. */
export function isLocal(info: SlotInfo): boolean {
  return !info.isPrimitive && info.envLevel === 0;
}

/** A closure-capture slot: resolved in an enclosing function scope, not
 *  the module or builtin scope. */
export function isCapture(info: SlotInfo): boolean {
  return !info.isPrimitive && !info.isModuleGlobal && info.envLevel > 0;
}

/** Build a SlotLookup. Params → 0..n-1, locals → n..m; non-locals resolve via env chain. */
export function buildSlotTable(env: Environment, paramNames: string[]): SlotLookup {
  const slots = new Map<string, SlotInfo>();

  for (let i = 0; i < paramNames.length; i++) {
    slots.set(paramNames[i], {
      slot: i,
      envLevel: 0,
      isPrimitive: false,
      isModuleGlobal: false,
    });
  }

  let nextSlot = paramNames.length;
  for (const name of env.names.keys()) {
    if (!slots.has(name)) {
      slots.set(name, {
        slot: nextSlot++,
        envLevel: 0,
        isPrimitive: false,
        isModuleGlobal: false,
      });
    }
  }

  const lookup = (token: Token): SlotInfo => {
    const name = token.lexeme;

    const local = slots.get(name);
    if (local) return local;

    const declaringEnv = env.lookupNameEnvByString(name);
    if (declaringEnv === null) {
      // Memoization intrinsics are injected post-resolution; treat as primitives.
      if (name.startsWith("__memo_")) {
        return { slot: -1, envLevel: 0, isPrimitive: true, isModuleGlobal: false };
      }
      throw new Error(`Variable ${name} not found in environment`);
    }

    // Outermost (null-enclosing) env = built-in scope; treat as primitive.
    if (declaringEnv.enclosing === null) {
      return { slot: -1, envLevel: 0, isPrimitive: true, isModuleGlobal: false };
    }

    // Module scope sits one step inside the built-in scope.
    const isModuleGlobal = declaringEnv.enclosing.enclosing === null;
    const envLevel = env.lookupNameByString(name);
    return { slot: 0, envLevel, isPrimitive: false, isModuleGlobal };
  };

  return Object.assign(lookup, { slotCount: nextSlot });
}
