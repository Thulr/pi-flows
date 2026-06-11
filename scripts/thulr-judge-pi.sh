#!/usr/bin/env bash
# thulr judge-bin wrapper: exec `pi` with thulr's judge args, minus --no-extensions.
#
# Why this exists: thulr's default judge invocation is
#   pi -p --no-tools --no-extensions --no-session --model <m> <prompt|@file>
# and `--no-extensions` unloads extension-provided model providers — e.g.
# pi-llama's `llama-cpp/...` provider for a local llama.cpp server — so judging
# on a local model fails with "Model not found". This wrapper re-enables
# extensions and keeps everything else (including pi's @file prompt handling).
#
# It also tolerates a crash AFTER the verdict: an extension teardown bug in
# one-shot `pi -p` mode can exit non-zero once the answer is already printed.
# If stdout carries a VERDICT: line, that judgment stands regardless of the
# exit code; anything else propagates as a real failure for thulr to classify.
#
# Use (judge on a local model while a cloud judge is unavailable):
#   THULR_JUDGE_BIN="$PWD/scripts/thulr-judge-pi.sh" \
#     thulr judge --trace evals/thulr-trace.jsonl \
#       --model "llama-cpp/<model-id>" --out .thulr/runs/candidate.json
# or pass `--judge-bin "$PWD/scripts/thulr-judge-pi.sh"` to any thulr command.
set -uo pipefail
args=()
for a in "$@"; do
	[[ "$a" == "--no-extensions" ]] || args+=("$a")
done
out=$(pi "${args[@]}")
code=$?
printf '%s\n' "$out"
if [[ $code -ne 0 && "$out" == *VERDICT:* ]]; then
	exit 0
fi
exit $code
