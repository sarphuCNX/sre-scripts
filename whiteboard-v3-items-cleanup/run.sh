#!/usr/bin/env bash
# run.sh — back up and clear flowitems.flow.items of ONE migrated v3 whiteboard.
#
# Standalone: needs only bash and mongosh. Copy this whole folder anywhere (run.sh,
# cleanup.js and lib/ must stay together), then:
#   cp .env.example .env      # set WB_CLEANUP_MONGO_URI at least
#   bash run.sh --dry-run     # checks + export only, no database writes
#   bash run.sh               # checks, export, confirm, back up, clear
#
# Usage:
#   bash run.sh [--dry-run] [--env-file PATH]
#     --dry-run    run every check and write the export file, but change nothing in the database
#     --env-file   .env to read (default: .env next to this script, if present)
#   Variables already exported in your shell win over the file.
#
# Steps: prompt for the flowId; check (one flowitems document, version 3, flow.migratedAt set,
# flowitementryv3 entries, non-empty flow.items, no different backup); export the document as
# canonical Extended JSON; ask you to retype the flowId; check the document still matches the
# export; back up {flowId, items} (w: majority) and verify the count on the server; clear
# flow.items only if _id, item count and updatedAt still match. A backup left by an
# interrupted run that holds exactly the current items is reused, so re-running is safe.
#
# Exit codes: 0 cleared (or dry run passed), 1 aborted with flow.items unchanged,
#             2 configuration, mongosh or database error.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CLEANUP_JS="${SCRIPT_DIR}/cleanup.js"
LIB_MAIN_JS="${SCRIPT_DIR}/lib/main.js"
DEFAULT_ENV_FILE="${SCRIPT_DIR}/.env"
DEFAULT_DATABASE="brightclass_whiteboard"
DEFAULT_BACKUP_DIR="./output/whiteboard_v3_items_cleanup"
DEFAULT_BACKUP_COLLECTION="flowitems_cleanup"
MONGOSH="${MONGOSH:-mongosh}"
STATE_PREFIX="WB_STATE "
EXIT_CLEARED=0
EXIT_ABORTED=1
EXIT_ERROR=2
JS_EXIT_OK=0
JS_EXIT_ABORTED=10

# Set by the steps in main(), in order.
DRY_RUN=0
ENV_FILE=""
BACKUP_COLLECTION=""
EFFECTIVE_DATABASE=""
BACKUP_DIR=""
TARGET=""
FLOW_ID=""
EXPORT_FILE=""
ITEM_COUNT=""
V3_ENTRY_COUNT=""
DOCUMENT_ID=""

# ---------------------------------------------------------------------------------------------
# Small helpers (sourced by the tests; no side effects)
# ---------------------------------------------------------------------------------------------

fail() {
  printf 'error: %s\n' "$*" >&2
  exit "${EXIT_ERROR}"
}

abort() {
  printf 'aborted: %s\n' "$*" >&2
  exit "${EXIT_ABORTED}"
}

usage() {
  sed -n '2,/^$/s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"
}

# trim TEXT — print TEXT without leading and trailing whitespace.
trim() {
  local text="$1"
  text="${text#"${text%%[![:space:]]*}"}"
  text="${text%"${text##*[![:space:]]}"}"
  printf '%s' "${text}"
}

# unquote VALUE — strip one pair of matching quotes; for an unquoted value, drop an inline
# " # comment" (from the first one, as .env readers do).
unquote() {
  local value="$1" quote="${1:0:1}" rest
  if [[ "${quote}" == '"' || "${quote}" == "'" ]]; then
    rest="${value:1}"
    if [[ "${rest}" == *"${quote}"* ]]; then
      printf '%s' "${rest%%"${quote}"*}"
      return
    fi
  fi
  [[ "${value}" == '#'* ]] && value=""
  # %% removes the longest matching suffix, i.e. everything from the FIRST " #".
  trim "${value%%[[:space:]]#*}"
}

# load_env_file FILE — export each WB_CLEANUP_* assignment in FILE unless the shell already
# exports that variable. Lines are parsed, never sourced, so the file cannot run commands.
load_env_file() {
  local file="$1" line key value
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="$(trim "${line%$'\r'}")"
    [[ -z "${line}" || "${line}" == '#'* ]] && continue
    line="${line#export }"
    [[ "${line}" == *=* ]] || continue
    key="$(trim "${line%%=*}")"
    value="$(unquote "$(trim "${line#*=}")")"
    [[ "${key}" =~ ^WB_CLEANUP_[A-Z_]+$ ]] || continue
    if ! printenv "${key}" >/dev/null 2>&1; then
      export "${key}=${value}"
    fi
  done <"${file}"
}

# redact_uri URI — print host:port/db with scheme, credentials and query string removed.
redact_uri() {
  local rest="${1#*://}"
  rest="${rest%%\?*}"
  printf '%s' "${rest##*@}"
}

# uri_database URI — print the database named in the URI path, or nothing.
uri_database() {
  local rest
  rest="$(redact_uri "$1")"
  [[ "${rest}" == */* ]] && printf '%s' "${rest#*/}"
  return 0
}

# valid_flow_id ID — succeed if ID is a plain id (letters, digits, '-' and '_').
valid_flow_id() {
  [[ "$1" =~ ^[A-Za-z0-9_-]+$ ]]
}

# check_backup_collection NAME — fail unless NAME is safe to write backups into.
check_backup_collection() {
  case "$1" in
    flowitems | flowitementryv3)
      fail "WB_CLEANUP_BACKUP_COLLECTION=$1 is a source collection; use a separate one, e.g. ${DEFAULT_BACKUP_COLLECTION}"
      ;;
    system.* | *'$'*)
      fail "WB_CLEANUP_BACKUP_COLLECTION='$1' is not a usable collection name"
      ;;
  esac
}

# utc_timestamp — print the current UTC time as YYYYmmddTHHMMSSZ.
utc_timestamp() {
  date -u +%Y%m%dT%H%M%SZ
}

# free_export_path DIR FLOW_ID STAMP — print DIR/FLOW_ID-STAMP.json, or with -1, -2, ... appended
# when that file already exists (two runs within the same second never collide).
free_export_path() {
  local base="$1/$2-$3" candidate="$1/$2-$3.json" suffix=1
  while [[ -e "${candidate}" ]]; do
    candidate="${base}-${suffix}.json"
    suffix=$((suffix + 1))
  done
  printf '%s' "${candidate}"
}

# ---------------------------------------------------------------------------------------------
# Steps, in the order main() runs them
# ---------------------------------------------------------------------------------------------

# parse_args ARGS... — set DRY_RUN and ENV_FILE.
parse_args() {
  while (($# > 0)); do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --env-file)
        [[ $# -ge 2 ]] || fail "--env-file needs a path"
        ENV_FILE="$2"
        shift
        ;;
      -h | --help)
        usage
        exit "${EXIT_CLEARED}"
        ;;
      *) fail "unknown argument: $1 (see --help)" ;;
    esac
    shift
  done
}

# load_settings — read .env, check the environment, and resolve database, target and paths.
load_settings() {
  if [[ -n "${ENV_FILE}" ]]; then
    [[ -f "${ENV_FILE}" ]] || fail "env file not found: ${ENV_FILE}"
    load_env_file "${ENV_FILE}"
  elif [[ -f "${DEFAULT_ENV_FILE}" ]]; then
    load_env_file "${DEFAULT_ENV_FILE}"
  fi

  [[ -n "${WB_CLEANUP_MONGO_URI:-}" ]] ||
    fail "WB_CLEANUP_MONGO_URI is not set; copy .env.example to ${DEFAULT_ENV_FILE} and set it"
  command -v "${MONGOSH}" >/dev/null 2>&1 || fail "mongosh not found on PATH"
  [[ -f "${CLEANUP_JS}" && -f "${LIB_MAIN_JS}" ]] ||
    fail "cleanup.js and lib/ must sit next to run.sh in ${SCRIPT_DIR}"

  BACKUP_COLLECTION="${WB_CLEANUP_BACKUP_COLLECTION:-${DEFAULT_BACKUP_COLLECTION}}"
  check_backup_collection "${BACKUP_COLLECTION}"
  EFFECTIVE_DATABASE="$(uri_database "${WB_CLEANUP_MONGO_URI}")"
  EFFECTIVE_DATABASE="${EFFECTIVE_DATABASE:-${WB_CLEANUP_DATABASE:-${DEFAULT_DATABASE}}}"
  BACKUP_DIR="${WB_CLEANUP_BACKUP_DIR:-${DEFAULT_BACKUP_DIR}}"
  TARGET="$(redact_uri "${WB_CLEANUP_MONGO_URI}")"
  TARGET="${TARGET%%/*}/${EFFECTIVE_DATABASE}"
}

# prompt_flow_id — read and validate FLOW_ID, then name EXPORT_FILE.
prompt_flow_id() {
  local mode_note=""
  ((DRY_RUN)) && mode_note=" (dry run)"
  printf 'target: %s%s\n' "${TARGET}" "${mode_note}"

  read -r -p 'flowId: ' FLOW_ID || FLOW_ID=""
  FLOW_ID="$(trim "${FLOW_ID}")"
  [[ -n "${FLOW_ID}" ]] || abort "flowId is empty"
  valid_flow_id "${FLOW_ID}" ||
    abort "flowId '${FLOW_ID}' may only contain letters, digits, '-' and '_'"

  mkdir -p "${BACKUP_DIR}" || fail "cannot create ${BACKUP_DIR}"
  EXPORT_FILE="$(free_export_path "${BACKUP_DIR}" "${FLOW_ID}" "$(utc_timestamp)")"
}

# run_phase PHASE — run cleanup.js in mongosh for one phase. The URI travels in the
# environment, not on the command line, so credentials never show in the process list.
run_phase() {
  WB_CLEANUP_PHASE="$1" \
    WB_CLEANUP_FLOW_ID="${FLOW_ID}" \
    WB_CLEANUP_MONGO_URI="${WB_CLEANUP_MONGO_URI}" \
    WB_CLEANUP_EFFECTIVE_DATABASE="${EFFECTIVE_DATABASE}" \
    WB_CLEANUP_BACKUP_COLLECTION="${BACKUP_COLLECTION}" \
    WB_CLEANUP_EXPORT_FILE="${EXPORT_FILE}" \
    WB_CLEANUP_LIB="${LIB_MAIN_JS}" \
    "${MONGOSH}" --nodb --quiet --norc --file "${CLEANUP_JS}" </dev/null
}

# exit_for_phase_status STATUS — exit run.sh with the code matching a failed phase.
exit_for_phase_status() {
  if [[ "$1" == "${JS_EXIT_ABORTED}" ]]; then
    exit "${EXIT_ABORTED}"
  fi
  exit "${EXIT_ERROR}"
}

# read_state_lines — read phase output on stdin: keep WB_STATE values, echo the rest to stderr.
read_state_lines() {
  local line key value
  while IFS= read -r line; do
    if [[ "${line}" != "${STATE_PREFIX}"* ]]; then
      [[ -n "${line}" ]] && printf '%s\n' "${line}" >&2
      continue
    fi
    line="${line#"${STATE_PREFIX}"}"
    key="${line%%=*}"
    value="${line#*=}"
    case "${key}" in
      ITEM_COUNT) ITEM_COUNT="${value}" ;;
      V3_ENTRY_COUNT) V3_ENTRY_COUNT="${value}" ;;
      DOCUMENT_ID) DOCUMENT_ID="${value}" ;;
    esac
  done
}

# check_and_export — phase 1: checks and the export file; no database writes.
check_and_export() {
  local output="" status=0
  output="$(run_phase check-export)" || status=$?
  read_state_lines <<<"${output}"
  ((status == JS_EXIT_OK)) || exit_for_phase_status "${status}"
  [[ -n "${ITEM_COUNT}" ]] || fail "the check phase returned no item count; see the output above"
}

# report_dry_run — print what a real run would clear.
report_dry_run() {
  printf 'flowId %s: dry run: checks passed, %s items would be cleared\n' "${FLOW_ID}" "${ITEM_COUNT}"
  printf '  v3 entries: %s\n' "${V3_ENTRY_COUNT}"
  printf '  export:     %s\n' "${EXPORT_FILE}"
}

# confirm — show what will change and require the flowId to be typed again.
confirm() {
  local retyped=""
  printf 'About to clear flowitems.flow.items of flowId %s\n' "${FLOW_ID}"
  printf '  target:        %s\n' "${TARGET}"
  printf '  flowitems _id: %s\n' "${DOCUMENT_ID}"
  printf '  items:         %s (copied to %s first)\n' "${ITEM_COUNT}" "${BACKUP_COLLECTION}"
  printf '  v3 entries:    %s\n' "${V3_ENTRY_COUNT}"
  printf '  export:        %s\n' "${EXPORT_FILE}"
  read -r -p 'Type the flowId again to confirm: ' retyped || retyped=""
  [[ "$(trim "${retyped}")" == "${FLOW_ID}" ]] || abort "not confirmed; nothing was changed"
}

# apply_cleanup — phase 2: re-check against the export, back up, verify, clear.
apply_cleanup() {
  local status=0
  run_phase apply || status=$?
  ((status == JS_EXIT_OK)) || exit_for_phase_status "${status}"
  printf '  export:     %s\n' "${EXPORT_FILE}"
}

main() {
  parse_args "$@"
  load_settings
  prompt_flow_id
  check_and_export
  if ((DRY_RUN)); then
    report_dry_run
    exit "${EXIT_CLEARED}"
  fi
  confirm
  apply_cleanup
  exit "${EXIT_CLEARED}"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
