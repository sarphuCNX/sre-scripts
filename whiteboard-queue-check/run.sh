#!/usr/bin/env bash
# run.sh — read-only check that the whiteboard update queue no longer keeps completed jobs.
#
# Standalone: needs bash and redis-cli. Copy this folder to the host, then from inside it:
#   bash run.sh                                       # two samples, 120 s apart
#   bash run.sh --deployed-at 2026-10-13T19:30:00Z    # also count jobs kept since the deploy
#
# Usage:
#   bash run.sh [--deployed-at YYYY-MM-DDTHH:MM:SSZ] [--env-file PATH]
#     --deployed-at  UTC time the fix went live (overrides WB_QUEUE_CHECK_DEPLOYED_AT)
#     --env-file     .env to read (default: .env next to this script, if present)
#   Variables already exported in your shell win over the file. If Redis needs a password,
#   export REDISCLI_AUTH before running (redis-cli reads it; it is never printed).
#
# READ-ONLY on Redis: PING, TIME, EXISTS, ZCARD, ZCOUNT, LLEN, GET, HLEN, DBSIZE, INFO and
# CONFIG GET only, each O(1) or O(log n). Never KEYS or SCAN, never a write, never job data.
# The ONLY write is its own report: <log dir>/whiteboard-queue-<UTC timestamp>.log.
#
# Exit codes: 0 PASS (warnings allowed), 1 FAIL, 2 configuration error or Redis unreachable.

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ENV_FILE="${SCRIPT_DIR}/.env"
DEFAULT_REDIS_HOST="127.0.0.1"
DEFAULT_REDIS_PORT=6379
DEFAULT_REDIS_DB=0
DEFAULT_SAMPLE_SECONDS=120
DEFAULT_MAX_WAITING=1000
DEFAULT_COMMAND_TIMEOUT_SECONDS=10
DEFAULT_LOG_DIR="./logs"
EXIT_PASS=0
EXIT_FAIL=1
EXIT_ERROR=2
KILL_GRACE_SECONDS=2
MAX_REDIS_DB=15
MILLISECONDS_PER_SECOND=1000
MICROSECONDS_PER_MILLISECOND=1000
# kneura-web-teach-server queues/whiteboardQueue.js and whiteboardWorker.js.
QUEUE_PREFIX="bull:whiteboard-update-queue"
FLOW_MAP_KEY="whiteboard:flowMap"
BATCH_INTERVAL_SECONDS=60

# Set by parse_args() / load_settings().
ENV_FILE=""
DEPLOYED_AT_ARGUMENT=""
REDIS_HOST=""
REDIS_PORT=""
REDIS_DB=""
SAMPLE_SECONDS=""
MAX_WAITING=""
COMMAND_TIMEOUT_SECONDS=""
LOG_DIR=""
DEPLOYED_AT=""
DEPLOYED_MS=""

# ---------------------------------------------------------------------------------------------
# Small helpers (sourced by the tests; no side effects)
# ---------------------------------------------------------------------------------------------

fail() {
  printf 'error: %s\n' "$*" >&2
  exit "${EXIT_ERROR}"
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

# unquote VALUE — strip surrounding quotes, or an unquoted trailing " # comment".
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
  trim "${value%%[[:space:]]#*}"
}

# load_env_file FILE — export WB_QUEUE_CHECK_* settings from FILE (parsed, never sourced);
# a variable already set in the environment wins.
load_env_file() {
  local file="$1" line key value
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="$(trim "${line%$'\r'}")"
    [[ -z "${line}" || "${line}" == '#'* ]] && continue
    line="${line#export }"
    [[ "${line}" == *=* ]] || continue
    key="$(trim "${line%%=*}")"
    value="$(unquote "$(trim "${line#*=}")")"
    [[ "${key}" =~ ^WB_QUEUE_CHECK_[A-Z_]+$ ]] || continue
    if ! printenv "${key}" >/dev/null 2>&1; then
      export "${key}=${value}"
    fi
  done <"${file}"
}

# positive_integer NAME VALUE — print VALUE, or fail when it is not a whole number above 0.
positive_integer() {
  local name="$1" value="$2"
  [[ "${value}" =~ ^[0-9]+$ ]] && ((10#${value} > 0)) || fail "${name} must be a whole number above 0, got '${value}'"
  printf '%d' "$((10#${value}))"
}

# redis_db_number NAME VALUE — print VALUE, or fail unless it is a database number 0..15.
redis_db_number() {
  local name="$1" value="$2"
  [[ "${value}" =~ ^[0-9]+$ ]] && ((10#${value} <= MAX_REDIS_DB)) || fail "${name} must be a database number from 0 to ${MAX_REDIS_DB}, got '${value}'"
  printf '%d' "$((10#${value}))"
}

# simple_name NAME VALUE — print VALUE, or fail unless it is a plain host name or address.
simple_name() {
  local name="$1" value="$2"
  [[ "${value}" =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]*$ ]] || fail "${name} must be a plain name, got '${value}'"
  printf '%s' "${value}"
}

# section TITLE — print a report heading.
section() {
  printf '\n===== %s =====\n' "$1"
}

# iso_to_epoch TIME — UTC epoch seconds for YYYY-MM-DDTHH:MM:SSZ, or fail.
# Pure arithmetic (days-from-civil), so it does not depend on GNU date.
iso_to_epoch() {
  local time="$1"
  [[ "${time}" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$ ]] ||
    fail "deploy time must look like 2026-10-13T19:30:00Z (UTC), got '${time}'"
  awk -v y="${BASH_REMATCH[1]}" -v m="${BASH_REMATCH[2]}" -v d="${BASH_REMATCH[3]}" \
    -v hh="${BASH_REMATCH[4]}" -v mm="${BASH_REMATCH[5]}" -v ss="${BASH_REMATCH[6]}" 'BEGIN {
      y += 0; m += 0; d += 0
      if (m <= 2) y -= 1
      era = int(y / 400); yoe = y - era * 400
      mp = (m + 9) % 12
      doy = int((153 * mp + 2) / 5) + d - 1
      doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
      printf "%d", (era * 146097 + doe - 719468) * 86400 + hh * 3600 + mm * 60 + ss }'
}

# info_field NAME — value of NAME from `redis-cli INFO` text on stdin (CR line endings removed).
info_field() {
  tr -d '\r' | awk -F: -v name="$1" '$1 == name {print $2; exit}'
}

# config_value — the value line of `redis-cli CONFIG GET <one key>` output on stdin.
config_value() {
  tr -d '\r' | sed -n 2p
}

# count_reply COMMAND REPLY — print REPLY when it is a whole number, or fail naming COMMAND
# (an error reply such as NOAUTH lands here).
count_reply() {
  local command="$1" reply
  reply="$(trim "${2%$'\r'}")"
  [[ "${reply}" =~ ^[0-9]+$ ]] || fail "unexpected reply to ${command}: '${reply}' (needs a password? export REDISCLI_AUTH)"
  printf '%s' "${reply}"
}

# time_reply_to_ms — epoch milliseconds from `redis-cli TIME` output on stdin (seconds, then
# microseconds, one per line). Bash arithmetic, so it is exact in 64 bits.
time_reply_to_ms() {
  local seconds="" micros=""
  IFS= read -r seconds
  IFS= read -r micros
  seconds="${seconds%$'\r'}"
  micros="${micros%$'\r'}"
  [[ "${seconds}" =~ ^[0-9]+$ && "${micros}" =~ ^[0-9]+$ ]] || fail "unexpected reply to TIME: '${seconds} ${micros}'"
  printf '%d' "$((10#${seconds} * MILLISECONDS_PER_SECOND + 10#${micros} / MICROSECONDS_PER_MILLISECOND))"
}

# verdict STATUS MESSAGE — one check result line.
verdict() {
  printf '%-4s  %s\n' "$1" "$2"
}

# check_completed_in_window KEPT ADDED WINDOW_SECONDS — the fix itself: no job that finished
# during the window may still sit in the completed set.
check_completed_in_window() {
  local kept="$1" added="$2" window="$3"
  if ((kept > 0)); then
    verdict FAIL "${kept} job(s) finished in the ${window} s window and were kept: completed jobs are still stored (fix not running?)"
  elif ((added == 0 && window < BATCH_INTERVAL_SECONDS)); then
    verdict WARN "no saves queued in a ${window} s window, shorter than the ${BATCH_INTERVAL_SECONDS} s batch interval: inconclusive"
  else
    verdict PASS "0 completed jobs kept in the ${window} s window (${added} save(s) queued meanwhile)"
  fi
}

# check_kept_since_deploy KEPT DEPLOYED_AT — no job that finished after the deploy is kept.
check_kept_since_deploy() {
  local kept="$1" deployed_at="$2"
  if ((kept > 0)); then
    verdict FAIL "${kept} completed job(s) finished after ${deployed_at} and were kept"
  else
    verdict PASS "0 completed jobs kept since ${deployed_at}"
  fi
}

# check_batch_updater_scheduled REPEAT_COUNT — the every-minute batch-update job is registered.
check_batch_updater_scheduled() {
  if (($1 > 0)); then
    verdict PASS "batch updater registered (${1} repeat registration(s))"
  else
    verdict FAIL "no repeat registration: the every-minute batch updater is not scheduled"
  fi
}

# check_worker_processing ADDED WAITING_FIRST WAITING_SECOND MAX_WAITING — jobs are being
# consumed, so an empty completed set means removal, not a stopped worker.
check_worker_processing() {
  local added="$1" waiting_first="$2" waiting_second="$3" max_waiting="$4"
  if ((waiting_second > max_waiting)); then
    verdict FAIL "${waiting_second} jobs waiting (limit ${max_waiting}): the worker is not keeping up or not running"
  elif ((added > 0 && waiting_second - waiting_first >= added)); then
    verdict FAIL "none of the ${added} save(s) queued in the window was processed: is the worker running?"
  else
    verdict PASS "worker is consuming jobs (${waiting_second} waiting, limit ${max_waiting})"
  fi
}

# check_failed_growth FAILED_FIRST FAILED_SECOND — failed jobs are kept on purpose; new ones
# are worth a look but do not fail the check.
check_failed_growth() {
  local growth=$(($2 - $1))
  if ((growth > 0)); then
    verdict WARN "${growth} job(s) failed in the window (kept on purpose; see the worker log)"
  else
    verdict PASS "no new failed jobs"
  fi
}

# check_eviction_policy POLICY — a job queue must not have its keys evicted.
check_eviction_policy() {
  case "$1" in
    noeviction) verdict PASS "maxmemory-policy is noeviction" ;;
    '') verdict WARN "could not read maxmemory-policy (CONFIG GET disabled?)" ;;
    *) verdict WARN "maxmemory-policy is $1: a job queue needs noeviction" ;;
  esac
}

# ---------------------------------------------------------------------------------------------
# Steps (read Redis, print the report)
# ---------------------------------------------------------------------------------------------

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --deployed-at)
        [[ $# -ge 2 ]] || fail "--deployed-at needs a UTC time like 2026-10-13T19:30:00Z"
        DEPLOYED_AT_ARGUMENT="$2"
        shift
        ;;
      --env-file)
        [[ $# -ge 2 ]] || fail "--env-file needs a path"
        ENV_FILE="$2"
        shift
        ;;
      -h | --help)
        usage
        exit "${EXIT_PASS}"
        ;;
      *) fail "unknown argument: $1 (see --help)" ;;
    esac
    shift
  done
}

load_settings() {
  local deployed_epoch
  if [[ -n "${ENV_FILE}" ]]; then
    [[ -f "${ENV_FILE}" ]] || fail "env file not found: ${ENV_FILE}"
    load_env_file "${ENV_FILE}"
  elif [[ -f "${DEFAULT_ENV_FILE}" ]]; then
    load_env_file "${DEFAULT_ENV_FILE}"
  fi

  REDIS_HOST="$(simple_name WB_QUEUE_CHECK_REDIS_HOST "${WB_QUEUE_CHECK_REDIS_HOST:-${DEFAULT_REDIS_HOST}}")" || exit
  REDIS_PORT="$(positive_integer WB_QUEUE_CHECK_REDIS_PORT "${WB_QUEUE_CHECK_REDIS_PORT:-${DEFAULT_REDIS_PORT}}")" || exit
  REDIS_DB="$(redis_db_number WB_QUEUE_CHECK_REDIS_DB "${WB_QUEUE_CHECK_REDIS_DB:-${DEFAULT_REDIS_DB}}")" || exit
  SAMPLE_SECONDS="$(positive_integer WB_QUEUE_CHECK_SAMPLE_SECONDS "${WB_QUEUE_CHECK_SAMPLE_SECONDS:-${DEFAULT_SAMPLE_SECONDS}}")" || exit
  MAX_WAITING="$(positive_integer WB_QUEUE_CHECK_MAX_WAITING "${WB_QUEUE_CHECK_MAX_WAITING:-${DEFAULT_MAX_WAITING}}")" || exit
  COMMAND_TIMEOUT_SECONDS="$(positive_integer WB_QUEUE_CHECK_COMMAND_TIMEOUT_SECONDS "${WB_QUEUE_CHECK_COMMAND_TIMEOUT_SECONDS:-${DEFAULT_COMMAND_TIMEOUT_SECONDS}}")" || exit
  LOG_DIR="${WB_QUEUE_CHECK_LOG_DIR:-${DEFAULT_LOG_DIR}}"
  DEPLOYED_AT="${DEPLOYED_AT_ARGUMENT:-${WB_QUEUE_CHECK_DEPLOYED_AT:-}}"
  if [[ -n "${DEPLOYED_AT}" ]]; then
    deployed_epoch="$(iso_to_epoch "${DEPLOYED_AT}")" || exit
    DEPLOYED_MS=$((deployed_epoch * MILLISECONDS_PER_SECOND))
  fi
}

# bounded SECONDS COMMAND... — run COMMAND, killed after SECONDS (hard kill KILL_GRACE_SECONDS
# later), so a Redis that stops answering can never hang this script.
bounded() {
  local seconds="$1"
  shift
  timeout -k "${KILL_GRACE_SECONDS}" "${seconds}" "$@"
}

# redis_cli ARGS... — bounded, read-only redis-cli call against the configured database.
redis_cli() {
  bounded "${COMMAND_TIMEOUT_SECONDS}" redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" -n "${REDIS_DB}" "$@"
}

# preflight — fail before any log is written when Redis does not answer or the queue is not
# in this database.
preflight() {
  local reply
  reply="$(redis_cli PING 2>&1)"
  [[ "$(trim "${reply//$'\r'/}")" == PONG ]] ||
    fail "Redis at ${REDIS_HOST}:${REDIS_PORT} db ${REDIS_DB} did not answer PING: '${reply}' (needs a password? export REDISCLI_AUTH)"
  reply="$(redis_cli EXISTS "${QUEUE_PREFIX}:meta" 2>&1)"
  [[ "$(trim "${reply//$'\r'/}")" == 1 ]] ||
    fail "${QUEUE_PREFIX}:meta not found in db ${REDIS_DB}: wrong database, or the queue never ran on this Redis"
}

# read_count VARIABLE COMMAND KEY [ARGS...] — set VARIABLE to the whole-number reply of
# `redis-cli COMMAND KEY ARGS`. A missing key read with GET counts as 0.
read_count() {
  local variable="$1" reply
  shift
  reply="$(redis_cli "$@")" || fail "redis-cli $1 $2 failed (Redis at ${REDIS_HOST}:${REDIS_PORT} gone?)"
  [[ "$1" == GET && -z "${reply}" ]] && reply=0
  reply="$(count_reply "$1 $2" "${reply}")" || exit
  printf -v "${variable}" '%s' "${reply}"
}

# read_sample PREFIX — read the queue counters into PREFIX_TIME_MS, PREFIX_COMPLETED, ...
read_sample() {
  local prefix="$1" time_ms
  time_ms="$(redis_cli TIME | time_reply_to_ms)" || exit
  printf -v "${prefix}_TIME_MS" '%s' "${time_ms}"
  read_count "${prefix}_COMPLETED" ZCARD "${QUEUE_PREFIX}:completed"
  read_count "${prefix}_FAILED" ZCARD "${QUEUE_PREFIX}:failed"
  read_count "${prefix}_WAITING" LLEN "${QUEUE_PREFIX}:wait"
  read_count "${prefix}_ACTIVE" LLEN "${QUEUE_PREFIX}:active"
  read_count "${prefix}_DELAYED" ZCARD "${QUEUE_PREFIX}:delayed"
  read_count "${prefix}_PRIORITIZED" ZCARD "${QUEUE_PREFIX}:prioritized"
  read_count "${prefix}_PAUSED" LLEN "${QUEUE_PREFIX}:paused"
  read_count "${prefix}_JOB_ID" GET "${QUEUE_PREFIX}:id"
  read_count "${prefix}_REPEAT" ZCARD "${QUEUE_PREFIX}:repeat"
  read_count "${prefix}_FLOW_MAP" HLEN "${FLOW_MAP_KEY}"
}

utc_timestamp() {
  date -u '+%Y%m%dT%H%M%SZ'
}

# open_log_file — create LOG_DIR if needed and print a new, unused log path inside it.
open_log_file() {
  local path
  mkdir -p "${LOG_DIR}" || fail "cannot create log directory ${LOG_DIR}"
  path="${LOG_DIR}/whiteboard-queue-$(utc_timestamp).log"
  [[ -e "${path}" ]] && path="${LOG_DIR}/whiteboard-queue-$(utc_timestamp)-$$.log"
  printf '%s' "${path}"
}

print_header() {
  section "1. target"
  printf 'host: %s   now: %s\n' "$(hostname)" "$(date -u '+%F %T UTC')"
  printf 'redis: %s:%s db %s   queue: %s\n' "${REDIS_HOST}" "${REDIS_PORT}" "${REDIS_DB}" "${QUEUE_PREFIX}"
  printf 'deployed at: %s\n' "${DEPLOYED_AT:-(not given)}"
}

# count_row LABEL FIRST SECOND — one line of the counts table.
count_row() {
  printf '%-40s %12s %12s %+12d\n' "$1" "$2" "$3" "$(($3 - $2))"
}

print_counts() {
  local window="$1"
  section "2. queue counts (two samples ${window} s apart)"
  printf '%-40s %12s %12s %12s\n' "" first second change
  count_row "completed (should not grow)" "${FIRST_COMPLETED}" "${SECOND_COMPLETED}"
  count_row "failed (kept on purpose)" "${FIRST_FAILED}" "${SECOND_FAILED}"
  count_row "waiting" "${FIRST_WAITING}" "${SECOND_WAITING}"
  count_row "active" "${FIRST_ACTIVE}" "${SECOND_ACTIVE}"
  count_row "delayed" "${FIRST_DELAYED}" "${SECOND_DELAYED}"
  count_row "prioritized" "${FIRST_PRIORITIZED}" "${SECOND_PRIORITIZED}"
  count_row "paused" "${FIRST_PAUSED}" "${SECOND_PAUSED}"
  count_row "jobs ever added (id counter)" "${FIRST_JOB_ID}" "${SECOND_JOB_ID}"
  count_row "repeat registrations (batch updater)" "${FIRST_REPEAT}" "${SECOND_REPEAT}"
  count_row "boards pending batch update (flowMap)" "${FIRST_FLOW_MAP}" "${SECOND_FLOW_MAP}"
  printf 'completed jobs finished inside the window: %s\n' "${KEPT_IN_WINDOW}"
  if [[ -n "${DEPLOYED_AT}" ]]; then
    printf 'completed jobs finished since %s: %s\n' "${DEPLOYED_AT}" "${KEPT_SINCE_DEPLOY}"
  fi
}

# print_redis — memory and eviction settings; sets EVICTION_POLICY.
EVICTION_POLICY=""
print_redis() {
  local memory
  section "3. redis memory"
  memory="$(redis_cli INFO memory)"
  printf 'used_memory_human: %s\n' "$(info_field used_memory_human <<<"${memory}")"
  printf 'maxmemory_human: %s\n' "$(info_field maxmemory_human <<<"${memory}")"
  EVICTION_POLICY="$(redis_cli CONFIG GET maxmemory-policy 2>/dev/null | config_value)"
  printf 'maxmemory-policy: %s\n' "${EVICTION_POLICY:-unknown}"
  printf 'keys in db %s: %s\n' "${REDIS_DB}" "$(redis_cli DBSIZE)"
  printf 'old completed jobs left for cleanup-whiteboard-completed.js: %s\n' "${SECOND_COMPLETED}"
}

# print_checks WINDOW_SECONDS — the verdicts and the overall result; returns EXIT_PASS or EXIT_FAIL.
print_checks() {
  local window="$1" added checks failures warnings
  added=$((SECOND_JOB_ID - FIRST_JOB_ID))
  section "4. checks"
  checks="$(
    check_completed_in_window "${KEPT_IN_WINDOW}" "${added}" "${window}"
    [[ -n "${DEPLOYED_AT}" ]] && check_kept_since_deploy "${KEPT_SINCE_DEPLOY}" "${DEPLOYED_AT}"
    check_worker_processing "${added}" "${FIRST_WAITING}" "${SECOND_WAITING}" "${MAX_WAITING}"
    check_batch_updater_scheduled "${SECOND_REPEAT}"
    check_failed_growth "${FIRST_FAILED}" "${SECOND_FAILED}"
    check_eviction_policy "${EVICTION_POLICY}"
  )"
  printf '%s\n' "${checks}"
  failures="$(grep -c '^FAIL' <<<"${checks}")"
  warnings="$(grep -c '^WARN' <<<"${checks}")"
  if ((failures > 0)); then
    printf '\nRESULT: FAIL (%d failed, %d warning(s))\n' "${failures}" "${warnings}"
    return "${EXIT_FAIL}"
  fi
  printf '\nRESULT: PASS (%d warning(s))\n' "${warnings}"
  return "${EXIT_PASS}"
}

print_report() {
  local window
  print_header
  read_sample FIRST
  printf '\nfirst sample taken; sampling again in %d s ...\n' "${SAMPLE_SECONDS}"
  sleep "${SAMPLE_SECONDS}"
  read_sample SECOND
  window=$(((SECOND_TIME_MS - FIRST_TIME_MS) / MILLISECONDS_PER_SECOND))
  read_count KEPT_IN_WINDOW ZCOUNT "${QUEUE_PREFIX}:completed" "(${FIRST_TIME_MS}" +inf
  if [[ -n "${DEPLOYED_AT}" ]]; then
    read_count KEPT_SINCE_DEPLOY ZCOUNT "${QUEUE_PREFIX}:completed" "${DEPLOYED_MS}" +inf
  fi
  print_counts "${window}"
  print_redis
  print_checks "${window}"
}

main() {
  local log_file status
  parse_args "$@"
  load_settings
  preflight
  log_file="$(open_log_file)" || exit
  print_report 2>&1 | tee "${log_file}"
  status="${PIPESTATUS[0]}"
  printf '\nsaved: %s\n' "${log_file}"
  exit "${status}"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
