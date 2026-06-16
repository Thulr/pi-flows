export const SELECTION_CASES = [
	{
		name: "trivial-answer-no-flow",
		task: "What is 2+2? Answer with only the number.",
		expectFlow: false,
		answerPattern: "\\b4\\b",
		mock: { flowCalls: 0, answer: "4" },
	},
	{
		name: "small-repo-lookup-no-flow",
		task: "In package.json, what is the package name? Answer with only the package name.",
		expectFlow: false,
		answerPattern: "\\bpi-flows\\b",
		mock: { flowCalls: 0, answer: "pi-flows" },
	},
	{
		name: "explicit-flow-list-uses-flow",
		task: "Use flow with {\"list\":true}.",
		expectFlow: true,
		answerPattern: "flow agents|recon|strategist",
		mock: { flowCalls: 1, answer: "Available flow agents: recon, strategist" },
	},
];
