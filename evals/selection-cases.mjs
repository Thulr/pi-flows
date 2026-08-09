// The tool-selection corpus, assembled from its negative and positive halves
// and stamped, via case-contract.mjs, with the portfolio metadata every case
// carries. Case literals
// live in the two modules below; this file exists so every consumer keeps one
// import and the corpus keeps one definition order.
import { defineCases } from "./case-contract.mjs";
import { DELEGATION_SELECTION_CASES } from "./selection-cases-delegation.mjs";
import { NO_FLOW_SELECTION_CASES } from "./selection-cases-no-flow.mjs";

export const SELECTION_CASES = defineCases([...NO_FLOW_SELECTION_CASES, ...DELEGATION_SELECTION_CASES]);
