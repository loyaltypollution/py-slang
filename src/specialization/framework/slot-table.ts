import type { Environment } from "../../resolver";
import type { Token } from "../../tokenizer";

export interface SlotInfo {
  slot: number;
  envLevel: number;
  isPrimitive: boolean;
  /** Name is declared at module scope (one step inside the outermost
   *  built-in scope). Module globals can be rebound between calls — purity
   *  treats their reads as impure, unlike closure captures of an enclosing
   *  function's locals. */
  isModuleGlobal: boolean;
}

/** Callable: token → SlotInfo. Also carries `slotCount` — the number of
 *  local slots the table was built with (parameters + other locals). Analyses
 *  that need to enumerate every slot at a program point (e.g. forward-must
 *  analyses whose entry seed must initialize every slot to avoid
 *  absent-treated-as-top collisions at CFG merges) read this directly instead
 *  of trying to recover the count from env traversal. */
export type SlotLookup = ((token: Token) => SlotInfo) & { readonly slotCount: number };

/** A slot is "local" iff it's a real variable (not a primitive binding) at the
 *  current function's envLevel. Shared across const/type/purity analyses and
 *  block-transfer's assignment-effect filter. */
export function isLocal(info: SlotInfo): boolean {
  return !info.isPrimitive && info.envLevel === 0;
}

/** A closure-capture slot: resolved in an enclosing function scope, not the
 *  module or builtin scope. Reads of captures depend on the outer frame but
 *  are not themselves side effects. */
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
