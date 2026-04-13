import { StmtNS } from "../../../ast-types";
import { buildCFG, type CFG } from "../../framework/cfg";
import { astOf } from "../inputs";
import type { Lattice } from "../lattice";
import { defineQuery, type QueryHandle } from "../query";

// CFG has no natural lattice — it's a structural product of the AST, not a
// monotone analysis fact. Reference-identity equality + last-write-wins join
// is sound because CFGs are a pure function of the AST and never merged
// across sources.
//
// `bottom` is `undefined` because there is no sensible empty CFG; the query
// throws rather than returning bottom when the AST input is unset. The handle
// is typed `CFG | undefined` to stay honest about the lattice; in practice
// `fn` never returns undefined (it throws), so callers can treat the result
// as CFG after a successful `db.get`.
//
// Caveat: `buildCFG` allocates fresh objects, so structurally-equal ASTs do
// NOT produce `===`-equal CFGs. Early-cutoff across cfgOf therefore never
// fires on rebuild. This is fine because `astOf`'s own `===` equality
// suppresses no-op AST writes upstream, so cfgOf is only ever re-run when the
// AST reference actually changed.
const cfgLattice: Lattice<CFG | undefined> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (_a, b) => b,
};

export const cfgOf: QueryHandle<number, CFG | undefined> = defineQuery<
  number,
  CFG | undefined
>({
  name: "cfgOf",
  lattice: cfgLattice,
  serialize: String,
  fn: (db, unitId) => {
    const ast = astOf.get(db, unitId);
    if (ast === undefined) {
      throw new Error(
        `cfgOf(${unitId}): no AST set — call astOf.set(db, ${unitId}, ast) first`,
      );
    }
    const body: StmtNS.Stmt[] = ast.statements;
    return buildCFG(body);
  },
});
