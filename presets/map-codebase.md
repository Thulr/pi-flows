---
name: map-codebase
description: Decompose a broad codebase question, inspect bounded areas, and synthesize one evidence map.
overrides: cwd,concurrency,timeoutMs,maxTokens,maxGeneratedTokens
---
{
  "task": "{task}",
  "orchestrate": {
    "commander": {
      "agent": "commander",
      "role": "decomposer",
      "tier": "capable"
    },
    "recon": {
      "agent": "recon",
      "role": "mapper",
      "tier": "fast",
      "thinking": "low"
    },
    "debrief": {
      "agent": "debrief",
      "role": "synthesizer",
      "tier": "capable"
    },
    "maxSubtasks": 4
  },
  "concurrency": 4,
  "timeoutMs": 1200000,
  "maxGeneratedTokens": 16000
}
