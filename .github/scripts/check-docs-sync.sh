#!/bin/sh
# Fail when a change touches product code without also touching README.md and a
# page under docs/. Run from the repository root:
#
#   .github/scripts/check-docs-sync.sh [base-ref [head-ref]]   # default: origin/main HEAD
#
# Product code is what users run or what the docs describe. Contributor tooling
# (.github/, .claude/), tests and fixtures, and the documentation surfaces
# themselves are not product code, so a docs-only or test-only change never
# trips this check.
set -eu

base=${1:-origin/main}
head=${2:-HEAD}
changed=$(git diff --name-only "$base"..."$head")

# ponytail: path lists, not a parser. Add a directory here when one ships code.
code=$(printf '%s\n' "$changed" | grep -E '^(packages/|workers/)' \
  | grep -vE '(^|/)(README|CLAUDE)\.md$|(^|/)(test|tests|fixtures)/' || true)

if [ -z "$code" ]; then
  echo "docs-sync: no product code changed."
  exit 0
fi

missing=
has() { printf '%s\n' "$changed" | grep -qE "$1"; }
has '^docs/.*\.md$'  || missing="$missing
  docs     docs/*.md (the page that owns the feature)"
has '^README\.md$'   || missing="$missing
  README   README.md"

if [ -z "$missing" ]; then
  echo "docs-sync: code, docs and README all changed."
  exit 0
fi

echo "docs-sync: product code changed without every documentation surface."
echo
echo "Code changed:"
printf '%s\n' "$code" | sed 's/^/  /'
echo
echo "Not changed:$missing"
echo
echo "Every code change updates docs/ and README.md in the same PR"
echo "(CLAUDE.md, 'Documentation is part of every feature')."
echo "Run /verify-docs --since $base --fix to find what each surface must say."
exit 1
