---
name: scout
description: One bounded read-only reconnaissance pass with compact evidence.
overrides: cwd,tier,thinking,timeoutMs,maxTokens,maxGeneratedTokens
---
{
  "agent": "recon",
  "task": "{task}",
  "tier": "fast",
  "thinking": "low",
  "timeoutMs": 900000,
  "maxGeneratedTokens": 6000
}
