import { BuiltinValue, StringValue, Value } from "../engines/cse/stash";
import {
  MEMO_INTRINSIC_NAMES,
  MEMO_MISS,
  memoLookup,
  memoPut,
} from "../runtime/memo";
import { GroupName } from "./utils";

function unwrap(v: Value): unknown {
  if (v === null || v === undefined) return v;
  const t = (v as { type?: string }).type;
  if (t === "none") return null;
  if ((v as { value?: unknown }).value !== undefined) return (v as { value: unknown }).value;
  return v;
}

function wrap(raw: unknown): Value {
  if (raw === null || raw === undefined) return { type: "none" } as Value;
  if (typeof raw === "number") return { type: "number", value: raw } as Value;
  if (typeof raw === "boolean") return { type: "bool", value: raw } as Value;
  if (typeof raw === "string") return { type: "string", value: raw } as Value;
  if (typeof raw === "bigint") return { type: "bigint", value: raw } as Value;
  return raw as Value;
}

function memoIdFrom(args: Value[]): { id: string; rest: Value[] } {
  const first = args[0];
  const id =
    typeof first === "object" && first && (first as StringValue).type === "string"
      ? (first as StringValue).value
      : String(unwrap(first));
  return { id, rest: args.slice(1) };
}

const [MEMO_HAS_NAME, MEMO_GET_NAME, MEMO_PUT_NAME] = MEMO_INTRINSIC_NAMES;

const memoBuiltins = new Map<string, BuiltinValue>();

memoBuiltins.set(MEMO_HAS_NAME, {
  type: "builtin",
  name: MEMO_HAS_NAME,
  minArgs: 1,
  func: (args: Value[]): Value => {
    const { id, rest } = memoIdFrom(args);
    return { type: "bool", value: memoLookup(id, rest.map(unwrap)) !== MEMO_MISS } as Value;
  },
});

memoBuiltins.set(MEMO_GET_NAME, {
  type: "builtin",
  name: MEMO_GET_NAME,
  minArgs: 1,
  func: (args: Value[]): Value => {
    const { id, rest } = memoIdFrom(args);
    const raw = memoLookup(id, rest.map(unwrap));
    if (raw === MEMO_MISS) return { type: "none" } as Value;
    return wrap(raw);
  },
});

memoBuiltins.set(MEMO_PUT_NAME, {
  type: "builtin",
  name: MEMO_PUT_NAME,
  minArgs: 2,
  func: (args: Value[]): Value => {
    const { id, rest } = memoIdFrom(args);
    // Last positional arg is the value; preceding ones form the cache key.
    const value = rest[rest.length - 1];
    const keyArgs = rest.slice(0, -1).map(unwrap);
    memoPut(id, keyArgs, unwrap(value));
    return value;
  },
});

export default {
  name: GroupName.MEMO,
  prelude: "",
  builtins: memoBuiltins,
};
