import type { DelegationContract, FlowAgentRefInput } from "./types.ts";

/** Resolve the contract dispatch will enforce for one child reference. */
export function resolveDelegationContract(
	ref: Pick<FlowAgentRefInput, "contract"> | undefined,
	fallback?: DelegationContract,
): DelegationContract | undefined {
	return ref?.contract ?? fallback;
}
