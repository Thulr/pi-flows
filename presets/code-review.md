---
name: code-review
description: One bounded, two-axis review of a fixed change set with typed findings and complete-coverage attestation.
overrides: cwd,model,tier,thinking,concurrency,timeoutMs,maxTokens,maxGeneratedTokens
result: code-review-v1
---
{
  "tasks": [
    {
      "agent": "overwatch",
      "role": "standards",
      "task": "Perform exactly one read-only Standards review for this request:\n\n{task}\n\nFreeze and report the base and head commit identities before reviewing. Derive one changed-file manifest from that fixed range, inspect every path in it, and return one coverage record per path. Review only against repository-authored standards (AGENTS.md, CONTRIBUTING.md, documented architecture and test rules) and semantic correctness. Do not invoke /code-review, call flow, spawn agents, edit files, post to GitHub, or retry the review. A missing fixed point, unreadable path, or uncertain scope must be represented as skipped coverage or an unresolved question, never silently treated as clean.",
      "tools": "read,grep,find,ls,bash-ro",
      "contract": {
        "objective": "Complete one author-independent Standards review of the fixed change set described by: {task}",
        "constraints": [
          "Read-only: do not change repository or external state.",
          "Freeze base/head identities and review every path in the resulting manifest.",
          "Return only evidence-backed semantic findings; do not manufacture style findings.",
          "Do not invoke another review workflow or agent."
        ],
        "nonGoals": [
          "Fixing findings",
          "Posting GitHub comments",
          "Repeating until clean",
          "Refreshing unrelated CI evidence"
        ],
        "dependencies": [
          "The caller-supplied task must identify a review target or fixed point."
        ],
        "authority": {
          "may": [
            "Read repository files and documentation",
            "Run read-only git inspection commands",
            "Run bounded non-mutating verification commands when necessary"
          ],
          "mustNot": [
            "Edit files",
            "Commit or push",
            "Post or resolve review comments",
            "Delegate or retry"
          ],
          "requiresApproval": []
        },
        "sideEffectClass": "read-only",
        "budget": {
          "timeoutMs": 1800000,
          "maxTokens": 300000,
          "maxGeneratedTokens": 12000
        },
        "acceptanceChecks": [
          "axis is standards",
          "coverage contains every changed path with reviewed or skipped status",
          "every finding has a path, line anchor, claim, evidence, and suggested fix",
          "uncertainty appears as skipped coverage or unresolvedQuestions"
        ],
        "returnSchema": {
          "type": "object",
          "additionalProperties": false,
          "required": ["axis", "base", "head", "coverage", "findings"],
          "properties": {
            "axis": { "const": "standards" },
            "base": { "type": "string", "pattern": "^[0-9a-f]{40,64}$" },
            "head": { "type": "string", "pattern": "^[0-9a-f]{40,64}$" },
            "coverage": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["path", "status", "evidence"],
                "properties": {
                  "path": { "type": "string", "minLength": 1 },
                  "status": { "enum": ["reviewed", "skipped"] },
                  "evidence": { "type": "string", "minLength": 1 }
                }
              }
            },
            "findings": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["id", "path", "startLine", "endLine", "severity", "category", "claim", "evidence", "suggestion"],
                "properties": {
                  "id": { "type": "string", "minLength": 1 },
                  "path": { "type": "string", "minLength": 1 },
                  "startLine": { "type": "integer", "minimum": 1 },
                  "endLine": { "type": "integer", "minimum": 1 },
                  "severity": { "enum": ["critical", "high", "medium", "low"] },
                  "category": { "type": "string", "minLength": 1 },
                  "claim": { "type": "string", "minLength": 1 },
                  "evidence": { "type": "string", "minLength": 1 },
                  "suggestion": { "type": "string", "minLength": 1 }
                }
              }
            }
          }
        },
        "owner": "standards"
      }
    },
    {
      "agent": "overwatch",
      "role": "spec",
      "task": "Perform exactly one read-only Spec review for this request:\n\n{task}\n\nFreeze and report the base and head commit identities before reviewing. Derive one changed-file manifest from that fixed range, inspect every path in it, and return one coverage record per path. Verify the change against the issue, PR intent, acceptance criteria, and review-comment follow-ups named in the request. Do not invoke /code-review, call flow, spawn agents, edit files, post to GitHub, or retry the review. A missing specification, unreadable path, or uncertain scope must be represented as skipped coverage or an unresolved question, never silently treated as clean.",
      "tools": "read,grep,find,ls,bash-ro",
      "contract": {
        "objective": "Complete one author-independent Spec review of the fixed change set described by: {task}",
        "constraints": [
          "Read-only: do not change repository or external state.",
          "Freeze base/head identities and review every path in the resulting manifest.",
          "Return only evidence-backed semantic findings tied to stated intent.",
          "Do not invoke another review workflow or agent."
        ],
        "nonGoals": [
          "Fixing findings",
          "Posting GitHub comments",
          "Repeating until clean",
          "Refreshing unrelated CI evidence"
        ],
        "dependencies": [
          "The caller-supplied task must identify the intended behavior and review target."
        ],
        "authority": {
          "may": [
            "Read repository files and supplied issue or PR context",
            "Run read-only git inspection commands",
            "Run bounded non-mutating verification commands when necessary"
          ],
          "mustNot": [
            "Edit files",
            "Commit or push",
            "Post or resolve review comments",
            "Delegate or retry"
          ],
          "requiresApproval": []
        },
        "sideEffectClass": "read-only",
        "budget": {
          "timeoutMs": 1800000,
          "maxTokens": 300000,
          "maxGeneratedTokens": 12000
        },
        "acceptanceChecks": [
          "axis is spec",
          "coverage contains every changed path with reviewed or skipped status",
          "every finding has a path, line anchor, claim, evidence, and suggested fix",
          "missing or ambiguous intent appears in unresolvedQuestions"
        ],
        "returnSchema": {
          "type": "object",
          "additionalProperties": false,
          "required": ["axis", "base", "head", "coverage", "findings"],
          "properties": {
            "axis": { "const": "spec" },
            "base": { "type": "string", "pattern": "^[0-9a-f]{40,64}$" },
            "head": { "type": "string", "pattern": "^[0-9a-f]{40,64}$" },
            "coverage": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["path", "status", "evidence"],
                "properties": {
                  "path": { "type": "string", "minLength": 1 },
                  "status": { "enum": ["reviewed", "skipped"] },
                  "evidence": { "type": "string", "minLength": 1 }
                }
              }
            },
            "findings": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["id", "path", "startLine", "endLine", "severity", "category", "claim", "evidence", "suggestion"],
                "properties": {
                  "id": { "type": "string", "minLength": 1 },
                  "path": { "type": "string", "minLength": 1 },
                  "startLine": { "type": "integer", "minimum": 1 },
                  "endLine": { "type": "integer", "minimum": 1 },
                  "severity": { "enum": ["critical", "high", "medium", "low"] },
                  "category": { "type": "string", "minLength": 1 },
                  "claim": { "type": "string", "minLength": 1 },
                  "evidence": { "type": "string", "minLength": 1 },
                  "suggestion": { "type": "string", "minLength": 1 }
                }
              }
            }
          }
        },
        "owner": "spec"
      }
    }
  ],
  "tier": "capable",
  "thinking": "high",
  "incompleteHandoffPolicy": "include",
  "concurrency": 2,
  "timeoutMs": 1800000,
  "maxTokens": 750000,
  "maxGeneratedTokens": 30000
}
