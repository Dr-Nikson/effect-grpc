#!/bin/sh
# .github/scripts/fixtures/fake-pnpm.sh
# Stands in for pnpm running the changesets CLI, which refuses `pre exit` outside pre mode and
# `version --snapshot` in pre mode, and which names a snapshot after the tag that --snapshot gets.
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
  tag=
  while [ $# -gt 0 ]; do
    case "$1" in
    --snapshot) tag=$2 ;;
    --snapshot=*) tag=${1#--snapshot=} ;;
    esac
    shift
  done
  version=$(printf '%s' "$CHANGESETS_VERSION_TEMPLATE" | sed "s/{tag}/$tag/g")
  printf '{"version":"%s"}' "$version" > packages/effect-grpc/package.json
  ;;
*" changeset publish "*)
  echo "$*" >> "$PUBLISHED"
  ;;
esac
