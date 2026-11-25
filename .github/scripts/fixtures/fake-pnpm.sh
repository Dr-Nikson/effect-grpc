#!/bin/sh
# .github/scripts/fixtures/fake-pnpm.sh
# Stands in for pnpm running the changesets CLI, which refuses `pre exit` outside pre mode and
# `version --snapshot` in pre mode.
case " $* " in
*" changeset pre exit "*)
  if [ ! -f .changeset/pre.json ]; then
    echo "changeset pre exit can only be run when in pre mode" >&2
    exit 1
  fi
  echo '{"mode":"exit"}' > .changeset/pre.json
  ;;
*" changeset version "*)
  if grep -qs '"mode":"pre"' .changeset/pre.json; then
    echo "Snapshot release is not allowed in pre mode" >&2
    exit 1
  fi
  printf '{"version":"%s"}' "$VERSIONED" > packages/effect-grpc/package.json
  ;;
*" changeset publish "*)
  echo "$*" >> "$PUBLISHED"
  ;;
esac
