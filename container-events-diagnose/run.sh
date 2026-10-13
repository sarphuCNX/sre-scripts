#!/usr/bin/env bash
# run.sh — read-only timeline of one container's stops and starts, and what host load did.
#
# Standalone: needs bash, the docker CLI, systemd (journalctl), sysstat (sar) and sudo (or run
# it as root). Copy this folder to the host, then from inside it:
#   bash run.sh                                                    # controller-server, last 6 h
#   bash run.sh --container liveclass-server --since 2026-10-13T05:00:00Z
#
# Usage:
#   bash run.sh [--container NAME] [--since YYYY-MM-DDTHH:MM:SSZ] [--env-file PATH]
#     --container   container to follow (default: controller-server)
#     --since       UTC start of the window (default: 6 hours ago); the window ends now
#     --env-file    .env to read (default: .env next to this script, if present)
#   Variables already exported in your shell win over the file.
#
# READ-ONLY on the host: `docker inspect`, `docker events --since … --until <now>` (finite,
# never a stream), `docker ps`, `journalctl -u docker` for the window, `grep` of shell history
# files, `sar -q` / `sar -u` and `uptime`. It starts/stops nothing and changes no settings.
# The ONLY write is its own report: <log dir>/container-events-<UTC timestamp>.log (default ./logs).
#
# LIGHT ON A LOADED HOST: lowers its OWN priority (nice 19, best-effort I/O level 7), bounds
# every external command with `timeout`, and refuses to start while another run holds the
# lock (flock on this script, no lock file written).
#
# Exit codes: 0 report printed, 2 configuration error, 3 another run is in progress.

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ENV_FILE="${SCRIPT_DIR}/.env"
DEFAULT_CONTAINER="controller-server"
DEFAULT_WINDOW_HOURS=6
DEFAULT_HISTORY_FILES="/root/.bash_history /home/*/.bash_history"
DEFAULT_JOURNAL_LINES=40
DEFAULT_COMMAND_TIMEOUT_SECONDS=30
DEFAULT_LOG_DIR="./logs"
EXIT_OK=0
EXIT_ERROR=2
EXIT_BUSY=3
NICE_LEVEL=19
IO_PRIORITY_CLASS=2
IO_PRIORITY_LEVEL=7
KILL_GRACE_SECONDS=2
SECONDS_PER_HOUR=3600
SECONDS_PER_DAY=86400
SHORT_ID_LENGTH=12
DOCKER_EVENT_ACTIONS='(create|start|restart|stop|kill|die|oom|destroy|pause|unpause|health_status)'

# Set by parse_args() / load_settings().
ENV_FILE=""
CONTAINER_ARGUMENT=""
SINCE_ARGUMENT=""
CONTAINER=""
WINDOW_HOURS=""
HISTORY_FILES=""
JOURNAL_LINES=""
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

# load_env_file FILE — export CONTAINER_DIAG_* settings from FILE (parsed, never sourced);
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
    [[ "${key}" =~ ^CONTAINER_DIAG_[A-Z_]+$ ]] || continue
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

# container_name NAME VALUE — print VALUE, or fail unless it is a plain docker container name.
container_name() {
  local name="$1" value="$2"
  [[ "${value}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || fail "${name} must be a container name, got '${value}'"
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
    fail "time must look like 2026-10-13T05:00:00Z (UTC), got '${time}'"
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

# name_pattern NAME — an ERE matching NAME as a whole container name, so "controller-server"
# does not also match "navneet-controller-server" (dots in NAME are escaped).
name_pattern() {
  local escaped="${1//./\\.}"
  printf '(^|[^A-Za-z0-9_.-])%s([^A-Za-z0-9_.-]|$)' "${escaped}"
}

# sar_start_time SINCE_EPOCH NOW_EPOCH — "HH:MM:SS" for `sar -s` when the window starts today
# (UTC), else "00:00:00" (sar reads one day's file; earlier days are not covered).
sar_start_time() {
  local since="$1" now="$2" iso
  if ((since / SECONDS_PER_DAY == now / SECONDS_PER_DAY)); then
    iso="$(epoch_to_iso "${since}")"
    iso="${iso#*T}"
    printf '%s' "${iso%Z}"
  else
    printf '00:00:00'
  fi
}

# ---------------------------------------------------------------------------------------------
# Steps (read docker, journals, history and sysstat; run read-only commands)
# ---------------------------------------------------------------------------------------------

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --container)
        [[ $# -ge 2 ]] || fail "--container needs a name"
        CONTAINER_ARGUMENT="$2"
        shift
        ;;
      --since)
        [[ $# -ge 2 ]] || fail "--since needs a UTC time like 2026-10-13T05:00:00Z"
        SINCE_ARGUMENT="$2"
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

  CONTAINER="$(container_name --container "${CONTAINER_ARGUMENT:-${CONTAINER_DIAG_CONTAINER:-${DEFAULT_CONTAINER}}}")" || exit
  WINDOW_HOURS="$(positive_integer CONTAINER_DIAG_WINDOW_HOURS "${CONTAINER_DIAG_WINDOW_HOURS:-${DEFAULT_WINDOW_HOURS}}")" || exit
  JOURNAL_LINES="$(positive_integer CONTAINER_DIAG_JOURNAL_LINES "${CONTAINER_DIAG_JOURNAL_LINES:-${DEFAULT_JOURNAL_LINES}}")" || exit
  COMMAND_TIMEOUT_SECONDS="$(positive_integer CONTAINER_DIAG_COMMAND_TIMEOUT_SECONDS "${CONTAINER_DIAG_COMMAND_TIMEOUT_SECONDS:-${DEFAULT_COMMAND_TIMEOUT_SECONDS}}")" || exit
  HISTORY_FILES="${CONTAINER_DIAG_HISTORY_FILES:-${DEFAULT_HISTORY_FILES}}"
  LOG_DIR="${CONTAINER_DIAG_LOG_DIR:-${DEFAULT_LOG_DIR}}"
  if [[ -n "${SINCE_ARGUMENT}" ]]; then
    iso_to_epoch "${SINCE_ARGUMENT}" >/dev/null || exit
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
    fail "needs root for journalctl and shell history: run 'sudo -v' first, or run with sudo"
}

# resolve_since_epoch NOW_EPOCH — epoch of --since, else NOW minus WINDOW_HOURS.
resolve_since_epoch() {
  if [[ -n "${SINCE_ARGUMENT}" ]]; then
    iso_to_epoch "${SINCE_ARGUMENT}"
  else
    printf '%d' "$(($1 - WINDOW_HOURS * SECONDS_PER_HOUR))"
  fi
}

utc_timestamp() {
  date -u '+%Y%m%dT%H%M%SZ'
}

# open_log_file — create LOG_DIR if needed and print a new, unused log path inside it.
open_log_file() {
  local path
  mkdir -p "${LOG_DIR}" || fail "cannot create log directory ${LOG_DIR}"
  path="${LOG_DIR}/container-events-$(utc_timestamp).log"
  [[ -e "${path}" ]] && path="${LOG_DIR}/container-events-$(utc_timestamp)-$$.log"
  printf '%s' "${path}"
}

print_header() {
  section "HOST"
  printf 'host: %s   container: %s\n' "$(hostname)" "${CONTAINER}"
  printf 'window: %s .. %s\n' "$(epoch_to_iso "$1")" "$(epoch_to_iso "$2")"
}

# print_state — current state, last start / stop and restart count; sets CONTAINER_SHORT_ID.
CONTAINER_SHORT_ID=""
print_state() {
  local id
  section "1. ${CONTAINER} now: status, last start, last stop, restarts"
  bounded "${COMMAND_TIMEOUT_SECONDS}" docker inspect -f \
    '{{.Name}} status={{.State.Status}} started={{.State.StartedAt}} finished={{.State.FinishedAt}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}} policy={{.HostConfig.RestartPolicy.Name}}' \
    "${CONTAINER}" || printf '(inspect failed: container missing or docker not answering)\n'
  id="$(bounded "${COMMAND_TIMEOUT_SECONDS}" docker inspect -f '{{.Id}}' "${CONTAINER}" 2>/dev/null)"
  CONTAINER_SHORT_ID="${id:0:${SHORT_ID_LENGTH}}"
}

# print_docker_events SINCE NOW — the container's lifecycle events in the window (finite).
print_docker_events() {
  section "2. docker events for ${CONTAINER} in the window (lifecycle only)"
  bounded "${COMMAND_TIMEOUT_SECONDS}" docker events \
    --since "$(epoch_to_iso "$1")" --until "$(epoch_to_iso "$2")" \
    --filter "container=${CONTAINER}" --format '{{.TimeNano}} {{.Action}} {{.Actor.Attributes.exitCode}}' 2>/dev/null |
    awk -v actions="^${DOCKER_EVENT_ACTIONS}" '$2 ~ actions {
        seconds = int(substr($1, 1, length($1) - 9))
        print seconds, $2, ($3 == "" ? "" : "exitCode=" $3) }' |
    while read -r seconds action exit_code; do
      printf '%s %s %s\n' "$(epoch_to_iso "${seconds}")" "${action}" "${exit_code}"
    done
  printf '(docker keeps a limited event history; an empty list does not prove nothing happened, see section 3)\n'
}

print_dockerd_journal() {
  section "3. dockerd journal lines for ${CONTAINER}${CONTAINER_SHORT_ID:+ (${CONTAINER_SHORT_ID})}"
  local pattern
  pattern="$(name_pattern "${CONTAINER}")"
  [[ -n "${CONTAINER_SHORT_ID}" ]] && pattern="${pattern}|${CONTAINER_SHORT_ID}"
  privileged journalctl -u docker --since "$(journal_time "$1")" --until "$(journal_time "$2")" --no-pager |
    grep -E -- "${pattern}" | cut -c1-200 | tail -"${JOURNAL_LINES}"
  return 0
}

print_shell_history() {
  local history_file
  section "4. stop / start / restart commands for ${CONTAINER} in shell history (no timestamps)"
  for history_file in ${HISTORY_FILES}; do
    privileged grep -HnE -- "docker( compose)? +(stop|start|restart|kill|rm|up|down)([[:space:]].*)?$(name_pattern "${CONTAINER}")" "${history_file}" 2>/dev/null |
      cut -c1-200 | tail -10
  done
  return 0
}

print_load_history() {
  local sar_start
  sar_start="$(sar_start_time "$1" "$2")"
  section "5. load average (sar -q, from ${sar_start} UTC)"
  bounded "${COMMAND_TIMEOUT_SECONDS}" sar -q -s "${sar_start}" 2>&1 | tail -60
  section "6. CPU user / system / idle (sar -u, from ${sar_start} UTC)"
  bounded "${COMMAND_TIMEOUT_SECONDS}" sar -u -s "${sar_start}" 2>&1 | tail -60
}

print_now() {
  section "7. now"
  bounded "${COMMAND_TIMEOUT_SECONDS}" uptime
  bounded "${COMMAND_TIMEOUT_SECONDS}" docker ps -a --format '{{.Names}} {{.Status}}' | awk -v name="${CONTAINER}" '$1 == name'
}

print_report() {
  local since="$1" now="$2"
  print_header "${since}" "${now}"
  print_state
  print_docker_events "${since}" "${now}"
  print_dockerd_journal "${since}" "${now}"
  print_shell_history
  print_load_history "${since}" "${now}"
  print_now
}

main() {
  local now since log_file
  parse_args "$@"
  load_settings
  acquire_single_run_lock
  lower_own_priority
  check_sudo
  now="$(date -u '+%s')"
  since="$(resolve_since_epoch "${now}")" || exit
  ((since < now)) || fail "--since must be in the past"
  log_file="$(open_log_file)" || exit
  print_report "${since}" "${now}" 2>&1 | tee "${log_file}"
  printf '\nsaved: %s\n' "${log_file}"
  exit "${EXIT_OK}"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
