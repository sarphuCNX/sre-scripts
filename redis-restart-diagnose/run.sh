#!/usr/bin/env bash
# run.sh — read-only look at WHY the host Redis restarted.
#
# Standalone: needs bash, procps (pgrep, ps), systemd (systemctl, journalctl), redis-cli and
# sudo (or run it as root). Copy this folder to the host, then from inside it:
#   bash run.sh                                        # event = Redis's own start time
#   bash run.sh --event-time 2026-10-13T05:10:32Z      # or name the event time (UTC)
#
# Usage:
#   bash run.sh [--event-time YYYY-MM-DDTHH:MM:SSZ] [--env-file PATH]
#     --event-time  UTC time of the restart (default: now minus Redis's uptime_in_seconds)
#     --env-file    .env to read (default: .env next to this script, if present)
#   Variables already exported in your shell win over the file. If Redis needs a password,
#   export REDISCLI_AUTH before running (redis-cli reads it; it is never printed).
#
# READ-ONLY on the host: `pgrep`, `ps`, `systemctl show` / `list-timers`, `journalctl` for a
# bounded window, `redis-cli INFO` / `CONFIG GET`, `tail` of Redis's own log file and `grep`
# of the cron files. It starts/stops nothing, changes no settings and never runs CONFIG SET.
# The ONLY write is its own report: <log dir>/redis-restart-<UTC timestamp>.log (default ./logs).
#
# LIGHT ON A LOADED HOST: lowers its OWN priority (nice 19, best-effort I/O level 7), bounds
# every external command with `timeout`, and refuses to start while another run holds the
# lock (flock on this script, no lock file written).
#
# Exit codes: 0 report printed, 2 configuration error, 3 another run is in progress.

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ENV_FILE="${SCRIPT_DIR}/.env"
DEFAULT_REDIS_PROCESS="redis-server"
DEFAULT_REDIS_HOST="127.0.0.1"
DEFAULT_REDIS_PORT=6379
DEFAULT_UNIT_MINUTES_BEFORE=10
DEFAULT_UNIT_MINUTES_AFTER=5
DEFAULT_SYSTEM_SECONDS_BEFORE=60
DEFAULT_SYSTEM_SECONDS_AFTER=20
DEFAULT_SYSTEM_JOURNAL_LINES=120
DEFAULT_REDIS_LOG_TAIL_LINES=200000
DEFAULT_CRON_PATHS="/etc/crontab /etc/cron.d /var/spool/cron/crontabs"
DEFAULT_JOURNAL_EXCLUDE="refusing its connections"
DEFAULT_COMMAND_TIMEOUT_SECONDS=30
DEFAULT_LOG_DIR="./logs"
EXIT_OK=0
EXIT_ERROR=2
EXIT_BUSY=3
NICE_LEVEL=19
IO_PRIORITY_CLASS=2
IO_PRIORITY_LEVEL=7
KILL_GRACE_SECONDS=2
SECONDS_PER_MINUTE=60
SYSTEMD_UNIT_PROPERTIES="Id,ActiveState,SubState,Result,Restart,NRestarts,ExecMainStartTimestamp,ExecMainExitTimestamp,ExecMainCode,ExecMainStatus,MemoryMax,OOMPolicy"

# Set by parse_args() / load_settings().
ENV_FILE=""
EVENT_TIME_ARGUMENT=""
REDIS_PROCESS=""
REDIS_HOST=""
REDIS_PORT=""
UNIT_MINUTES_BEFORE=""
UNIT_MINUTES_AFTER=""
SYSTEM_SECONDS_BEFORE=""
SYSTEM_SECONDS_AFTER=""
SYSTEM_JOURNAL_LINES=""
REDIS_LOG_TAIL_LINES=""
CRON_PATHS=""
JOURNAL_EXCLUDE=""
COMMAND_TIMEOUT_SECONDS=""
LOG_DIR=""

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

# load_env_file FILE — export REDIS_DIAG_* settings from FILE (parsed, never sourced);
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
    [[ "${key}" =~ ^REDIS_DIAG_[A-Z_]+$ ]] || continue
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

# simple_name NAME VALUE — print VALUE, or fail unless it is a plain process/host name.
simple_name() {
  local name="$1" value="$2"
  [[ "${value}" =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]*$ ]] || fail "${name} must be a plain name, got '${value}'"
  printf '%s' "${value}"
}

# section TITLE — print a report heading.
section() {
  printf '\n===== %s =====\n' "$1"
}

# iso_to_epoch TIME — UTC epoch seconds for YYYY-MM-DDTHH:MM:SS[.fraction]Z, or fail.
# Pure arithmetic (days-from-civil), so it does not depend on GNU date.
iso_to_epoch() {
  local time="$1"
  [[ "${time}" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?Z$ ]] ||
    fail "event time must look like 2026-10-13T05:10:32Z (UTC), got '${time}'"
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

# epoch_to_iso EPOCH — YYYY-MM-DDTHH:MM:SSZ (inverse of iso_to_epoch).
epoch_to_iso() {
  awk -v t="$1" 'BEGIN {
    days = int(t / 86400); rest = t - days * 86400
    z = days + 719468; era = int(z / 146097); doe = z - era * 146097
    yoe = int((doe - int(doe / 1460) + int(doe / 36524) - int(doe / 146096)) / 365)
    y = yoe + era * 400; doy = doe - (365 * yoe + int(yoe / 4) - int(yoe / 100))
    mp = int((5 * doy + 2) / 153); d = doy - int((153 * mp + 2) / 5) + 1
    m = mp < 10 ? mp + 3 : mp - 9; if (m <= 2) y += 1
    printf "%04d-%02d-%02dT%02d:%02d:%02dZ", y, m, d, int(rest / 3600), int(rest % 3600 / 60), rest % 60 }'
}

# journal_time EPOCH — the same instant as journalctl wants it: "YYYY-MM-DD HH:MM:SS UTC".
journal_time() {
  local iso
  iso="$(epoch_to_iso "$1")"
  iso="${iso/T/ }"
  printf '%s UTC' "${iso%Z}"
}

# info_field NAME — value of NAME from `redis-cli INFO` text on stdin (CR line endings removed).
info_field() {
  tr -d '\r' | awk -F: -v name="$1" '$1 == name {print $2; exit}'
}

# config_value — the value line of `redis-cli CONFIG GET <one key>` output on stdin.
config_value() {
  tr -d '\r' | sed -n 2p
}

# redis_log_lines_between START_EPOCH END_EPOCH — Redis log lines on stdin whose timestamp
# ("<pid>:<role> 13 Oct 2026 05:10:32.123 ...", treated as UTC) falls inside the window.
redis_log_lines_between() {
  awk -v start="$1" -v end="$2" '
    BEGIN { split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", names, " "); for (i = 1; i <= 12; i++) month[names[i]] = i }
    $1 ~ /^[0-9]+:[A-Z]$/ && ($3 in month) {
      y = $4 + 0; m = month[$3]; d = $2 + 0; split($5, clock, "[:.]")
      if (m <= 2) y -= 1
      era = int(y / 400); yoe = y - era * 400; mp = (m + 9) % 12
      doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + int((153 * mp + 2) / 5) + d - 1
      t = (era * 146097 + doe - 719468) * 86400 + clock[1] * 3600 + clock[2] * 60 + clock[3]
      if (t >= start && t <= end) print
    }'
}

# ---------------------------------------------------------------------------------------------
# Steps (read journals, redis and files; run read-only commands)
# ---------------------------------------------------------------------------------------------

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --event-time)
        [[ $# -ge 2 ]] || fail "--event-time needs a UTC time like 2026-10-13T05:10:32Z"
        EVENT_TIME_ARGUMENT="$2"
        shift
        ;;
      --env-file)
        [[ $# -ge 2 ]] || fail "--env-file needs a path"
        ENV_FILE="$2"
        shift
        ;;
      -h | --help)
        usage
        exit "${EXIT_OK}"
        ;;
      *) fail "unknown argument: $1 (see --help)" ;;
    esac
    shift
  done
}

load_settings() {
  if [[ -n "${ENV_FILE}" ]]; then
    [[ -f "${ENV_FILE}" ]] || fail "env file not found: ${ENV_FILE}"
    load_env_file "${ENV_FILE}"
  elif [[ -f "${DEFAULT_ENV_FILE}" ]]; then
    load_env_file "${DEFAULT_ENV_FILE}"
  fi

  REDIS_PROCESS="$(simple_name REDIS_DIAG_REDIS_PROCESS "${REDIS_DIAG_REDIS_PROCESS:-${DEFAULT_REDIS_PROCESS}}")" || exit
  REDIS_HOST="$(simple_name REDIS_DIAG_REDIS_HOST "${REDIS_DIAG_REDIS_HOST:-${DEFAULT_REDIS_HOST}}")" || exit
  REDIS_PORT="$(positive_integer REDIS_DIAG_REDIS_PORT "${REDIS_DIAG_REDIS_PORT:-${DEFAULT_REDIS_PORT}}")" || exit
  UNIT_MINUTES_BEFORE="$(positive_integer REDIS_DIAG_UNIT_MINUTES_BEFORE "${REDIS_DIAG_UNIT_MINUTES_BEFORE:-${DEFAULT_UNIT_MINUTES_BEFORE}}")" || exit
  UNIT_MINUTES_AFTER="$(positive_integer REDIS_DIAG_UNIT_MINUTES_AFTER "${REDIS_DIAG_UNIT_MINUTES_AFTER:-${DEFAULT_UNIT_MINUTES_AFTER}}")" || exit
  SYSTEM_SECONDS_BEFORE="$(positive_integer REDIS_DIAG_SYSTEM_SECONDS_BEFORE "${REDIS_DIAG_SYSTEM_SECONDS_BEFORE:-${DEFAULT_SYSTEM_SECONDS_BEFORE}}")" || exit
  SYSTEM_SECONDS_AFTER="$(positive_integer REDIS_DIAG_SYSTEM_SECONDS_AFTER "${REDIS_DIAG_SYSTEM_SECONDS_AFTER:-${DEFAULT_SYSTEM_SECONDS_AFTER}}")" || exit
  SYSTEM_JOURNAL_LINES="$(positive_integer REDIS_DIAG_SYSTEM_JOURNAL_LINES "${REDIS_DIAG_SYSTEM_JOURNAL_LINES:-${DEFAULT_SYSTEM_JOURNAL_LINES}}")" || exit
  REDIS_LOG_TAIL_LINES="$(positive_integer REDIS_DIAG_REDIS_LOG_TAIL_LINES "${REDIS_DIAG_REDIS_LOG_TAIL_LINES:-${DEFAULT_REDIS_LOG_TAIL_LINES}}")" || exit
  COMMAND_TIMEOUT_SECONDS="$(positive_integer REDIS_DIAG_COMMAND_TIMEOUT_SECONDS "${REDIS_DIAG_COMMAND_TIMEOUT_SECONDS:-${DEFAULT_COMMAND_TIMEOUT_SECONDS}}")" || exit
  CRON_PATHS="${REDIS_DIAG_CRON_PATHS:-${DEFAULT_CRON_PATHS}}"
  JOURNAL_EXCLUDE="${REDIS_DIAG_JOURNAL_EXCLUDE:-${DEFAULT_JOURNAL_EXCLUDE}}"
  LOG_DIR="${REDIS_DIAG_LOG_DIR:-${DEFAULT_LOG_DIR}}"
  if [[ -n "${EVENT_TIME_ARGUMENT}" ]]; then
    iso_to_epoch "${EVENT_TIME_ARGUMENT}" >/dev/null || exit
  fi
}

# bounded SECONDS COMMAND... — run COMMAND, killed after SECONDS (hard kill KILL_GRACE_SECONDS
# later), so a command stuck on a busy host can never hang or outlive this script.
bounded() {
  local seconds="$1"
  shift
  timeout -k "${KILL_GRACE_SECONDS}" "${seconds}" "$@"
}

# privileged COMMAND... — bounded COMMAND as root (sudo -n unless already root).
privileged() {
  if ((EUID == 0)); then
    bounded "${COMMAND_TIMEOUT_SECONDS}" "$@"
  else
    bounded "${COMMAND_TIMEOUT_SECONDS}" sudo -n "$@"
  fi
}

# redis_cli ARGS... — bounded, read-only redis-cli call against REDIS_HOST:REDIS_PORT.
redis_cli() {
  bounded "${COMMAND_TIMEOUT_SECONDS}" redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" "$@"
}

# lower_own_priority — nice 19 and best-effort I/O level 7 for THIS script (inherited by its
# children). Touches nothing else on the host; silently skipped where unsupported.
lower_own_priority() {
  renice -n "${NICE_LEVEL}" -p "$$" >/dev/null 2>&1 || true
  if command -v ionice >/dev/null 2>&1; then
    ionice -c "${IO_PRIORITY_CLASS}" -n "${IO_PRIORITY_LEVEL}" -p "$$" >/dev/null 2>&1 || true
  fi
}

# acquire_single_run_lock — exit EXIT_BUSY when another run holds the lock (flock on a
# read-only descriptor of this script; no lock file; released when the script exits).
acquire_single_run_lock() {
  command -v flock >/dev/null 2>&1 || return 0
  exec 9<"${BASH_SOURCE[0]}"
  if ! flock -n 9; then
    printf 'busy: another run.sh is already running on this host; wait for it to finish\n' >&2
    exit "${EXIT_BUSY}"
  fi
}

# check_sudo — fail early when not root and sudo would prompt for a password.
check_sudo() {
  ((EUID == 0)) && return 0
  bounded "${COMMAND_TIMEOUT_SECONDS}" sudo -n true 2>/dev/null ||
    fail "needs root for journalctl / the Redis log / cron files: run 'sudo -v' first, or run with sudo"
}

# resolve_event_epoch — epoch of --event-time, else now minus Redis's uptime_in_seconds.
resolve_event_epoch() {
  local uptime now
  if [[ -n "${EVENT_TIME_ARGUMENT}" ]]; then
    iso_to_epoch "${EVENT_TIME_ARGUMENT}"
    return
  fi
  uptime="$(redis_cli INFO server 2>/dev/null | info_field uptime_in_seconds)"
  [[ "${uptime}" =~ ^[0-9]+$ ]] || fail "could not read Redis uptime (auth? set REDISCLI_AUTH); pass --event-time"
  now="$(date -u '+%s')"
  printf '%d' "$((now - uptime))"
}

utc_timestamp() {
  date -u '+%Y%m%dT%H%M%SZ'
}

# open_log_file — create LOG_DIR if needed and print a new, unused log path inside it.
open_log_file() {
  local path
  mkdir -p "${LOG_DIR}" || fail "cannot create log directory ${LOG_DIR}"
  path="${LOG_DIR}/redis-restart-$(utc_timestamp).log"
  [[ -e "${path}" ]] && path="${LOG_DIR}/redis-restart-$(utc_timestamp)-$$.log"
  printf '%s' "${path}"
}

print_header() {
  section "HOST"
  printf 'host: %s   now: %s\n' "$(hostname)" "$(date -u '+%F %T UTC')"
  printf 'event (Redis restart): %s\n' "$(epoch_to_iso "$1")"
}

# print_process — prints the Redis server process, its parent and unit; sets REDIS_UNIT.
REDIS_UNIT=""
print_process() {
  local redis_pid parent_pid
  section "1. ${REDIS_PROCESS} server process (oldest match, not a bgsave child), parent, unit"
  redis_pid="$(bounded "${COMMAND_TIMEOUT_SECONDS}" pgrep -o -x "${REDIS_PROCESS}")"
  if [[ -z "${redis_pid}" ]]; then
    printf '%s not running\n' "${REDIS_PROCESS}"
    return
  fi
  bounded "${COMMAND_TIMEOUT_SECONDS}" ps -o pid,ppid,lstart,unit,args -p "${redis_pid}" | cut -c1-160
  parent_pid="$(bounded "${COMMAND_TIMEOUT_SECONDS}" ps -o ppid= -p "${redis_pid}" | tr -d ' ')"
  printf -- '-- parent\n'
  bounded "${COMMAND_TIMEOUT_SECONDS}" ps -o pid,args -p "${parent_pid}" | cut -c1-160
  REDIS_UNIT="$(bounded "${COMMAND_TIMEOUT_SECONDS}" ps -o unit= -p "${redis_pid}" | tr -d ' ')"
  printf -- '-- unit: %s\n' "${REDIS_UNIT:-none}"
  if [[ "${REDIS_UNIT}" == *.service ]]; then
    bounded "${COMMAND_TIMEOUT_SECONDS}" systemctl show "${REDIS_UNIT}" -p "${SYSTEMD_UNIT_PROPERTIES}" --no-pager
  fi
}

print_unit_journal() {
  local event_epoch="$1"
  section "2. ${REDIS_UNIT:-redis unit} journal (${UNIT_MINUTES_BEFORE} min before .. ${UNIT_MINUTES_AFTER} min after)"
  if [[ "${REDIS_UNIT}" != *.service ]]; then
    printf '(Redis is not running as a systemd service; see section 3 and the Redis log)\n'
    return
  fi
  privileged journalctl -u "${REDIS_UNIT}" \
    --since "$(journal_time "$((event_epoch - UNIT_MINUTES_BEFORE * SECONDS_PER_MINUTE))")" \
    --until "$(journal_time "$((event_epoch + UNIT_MINUTES_AFTER * SECONDS_PER_MINUTE))")" --no-pager |
    cut -c1-200 | tail -30
}

print_system_journal() {
  local event_epoch="$1"
  section "3. whole system journal (${SYSTEM_SECONDS_BEFORE}s before .. ${SYSTEM_SECONDS_AFTER}s after)"
  privileged journalctl \
    --since "$(journal_time "$((event_epoch - SYSTEM_SECONDS_BEFORE))")" \
    --until "$(journal_time "$((event_epoch + SYSTEM_SECONDS_AFTER))")" --no-pager |
    grep -vF -- "${JOURNAL_EXCLUDE}" | cut -c1-200 | head -"${SYSTEM_JOURNAL_LINES}"
}

# print_config — prints Redis version, persistence and memory settings; sets REDIS_LOG_FILE.
REDIS_LOG_FILE=""
print_config() {
  local key
  section "4. Redis config, memory and persistence (read-only INFO / CONFIG GET)"
  redis_cli INFO server | tr -d '\r' | grep -E '^(redis_version|uptime_in_seconds|executable|config_file|process_supervised):'
  for key in logfile save appendonly maxmemory maxmemory-policy; do
    printf '%s = %s\n' "${key}" "$(redis_cli CONFIG GET "${key}" | config_value)"
  done
  redis_cli INFO memory | tr -d '\r' | grep -E '^(used_memory_human|used_memory_rss_human|used_memory_peak_human|maxmemory_human|mem_fragmentation_ratio):'
  redis_cli INFO persistence | tr -d '\r' | grep -E '^(rdb_last_bgsave_status|rdb_last_bgsave_time_sec|rdb_changes_since_last_save|aof_enabled|loading):'
  REDIS_LOG_FILE="$(redis_cli CONFIG GET logfile | config_value)"
}

print_redis_log() {
  local event_epoch="$1"
  section "5. Redis's own log (${UNIT_MINUTES_BEFORE} min before .. ${UNIT_MINUTES_AFTER} min after)"
  if [[ -z "${REDIS_LOG_FILE}" ]]; then
    printf '(logfile is empty: Redis logs to stdout, i.e. the journal in section 2/3)\n'
    return
  fi
  privileged ls -la "$(dirname "${REDIS_LOG_FILE}")"
  privileged tail -n "${REDIS_LOG_TAIL_LINES}" "${REDIS_LOG_FILE}" |
    redis_log_lines_between "$((event_epoch - UNIT_MINUTES_BEFORE * SECONDS_PER_MINUTE))" "$((event_epoch + UNIT_MINUTES_AFTER * SECONDS_PER_MINUTE))" |
    cut -c1-200 | tail -60
}

print_schedules() {
  local cron_path
  section "6. scheduled jobs: systemd timers and cron lines mentioning redis"
  bounded "${COMMAND_TIMEOUT_SECONDS}" systemctl list-timers --all --no-pager | head -25
  printf -- '-- cron\n'
  for cron_path in ${CRON_PATHS}; do
    privileged grep -rniE 'redis' "${cron_path}" 2>/dev/null | grep -vE ':[[:space:]]*#' | cut -c1-200
  done
  return 0
}

print_report() {
  local event_epoch="$1"
  print_header "${event_epoch}"
  print_process
  print_unit_journal "${event_epoch}"
  print_system_journal "${event_epoch}"
  print_config
  print_redis_log "${event_epoch}"
  print_schedules
}

main() {
  local event_epoch log_file
  parse_args "$@"
  load_settings
  acquire_single_run_lock
  lower_own_priority
  check_sudo
  event_epoch="$(resolve_event_epoch)" || exit
  log_file="$(open_log_file)" || exit
  print_report "${event_epoch}" 2>&1 | tee "${log_file}"
  printf '\nsaved: %s\n' "${log_file}"
  exit "${EXIT_OK}"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
