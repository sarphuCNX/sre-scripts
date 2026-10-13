#!/usr/bin/env bash
# run.sh — read-only look at a front-door connection herd: what restarted the socket servers,
# and which upstream behind nginx is holding the connections.
#
# Standalone: needs bash, procps, iproute2 (ss), util-linux (nsenter, last), systemd
# (journalctl), the docker CLI, redis-cli, and sudo (or run it as root). Copy this folder to
# the host, then from inside it:
#   bash run.sh                                        # event time = controller-server's start
#   bash run.sh --event-time 2026-10-13T05:10:39Z      # or name the event time (UTC)
#
# Usage:
#   bash run.sh [--event-time YYYY-MM-DDTHH:MM:SSZ] [--env-file PATH]
#     --event-time  UTC time of the restart to investigate (default: StartedAt of the first
#                   INGRESS_DIAG_SOCKET_CONTAINERS entry)
#     --env-file    .env to read (default: .env next to this script, if present)
#   Variables already exported in your shell win over the file.
#
# READ-ONLY on the host. It reads journals (`journalctl`), the nginx container's json log FILE
# (`tail` from the end, so dockerd is not involved), connection tables inside nginx's network
# namespace (`nsenter -n ss`), `docker inspect`, a bounded `docker logs --since --until` of
# the socket servers around the event, `redis-cli INFO server`, `ps`, `last` and `pgrep`.
# It never runs `docker logs -f`, starts/stops nothing and changes no settings.
# The ONLY write is its own report: <log dir>/ingress-herd-<UTC timestamp>.log (default ./logs).
#
# LIGHT ON A LOADED HOST: lowers its OWN priority (nice 19, best-effort I/O level 7), bounds
# every external command with `timeout`, and refuses to start while another run holds the
# lock (flock on this script, no lock file written).
#
# Exit codes: 0 report printed, 2 configuration error, 3 another run is in progress.

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ENV_FILE="${SCRIPT_DIR}/.env"
DEFAULT_NGINX_CONTAINER="brightclass-nginx"
DEFAULT_SOCKET_CONTAINERS="controller-server broadcast-server"
DEFAULT_UPSTREAM_CONTAINERS="controller-server broadcast-server liveclass-server kneura-web-teach-server-pm2 navneet-web-teach-server"
DEFAULT_REDIS_SERVICE="redis-server"
DEFAULT_MINUTES_BEFORE=20
DEFAULT_MINUTES_AFTER=10
DEFAULT_NGINX_TAIL_LINES=100000
DEFAULT_COMMAND_TIMEOUT_SECONDS=30
DEFAULT_DOCKER_LOGS_TIMEOUT_SECONDS=90
DEFAULT_LOG_DIR="./logs"
LAST_LINES_BEFORE_RESTART=25
LAST_LINES_WINDOW_BEFORE_SECONDS=120
LAST_LINES_WINDOW_AFTER_SECONDS=10
EXIT_OK=0
EXIT_ERROR=2
EXIT_BUSY=3
NICE_LEVEL=19
IO_PRIORITY_CLASS=2
IO_PRIORITY_LEVEL=7
KILL_GRACE_SECONDS=2
SECONDS_PER_MINUTE=60

# Set by parse_args() / load_settings().
ENV_FILE=""
EVENT_TIME_ARGUMENT=""
NGINX_CONTAINER=""
SOCKET_CONTAINERS=""
UPSTREAM_CONTAINERS=""
REDIS_SERVICE=""
MINUTES_BEFORE=""
MINUTES_AFTER=""
NGINX_TAIL_LINES=""
COMMAND_TIMEOUT_SECONDS=""
DOCKER_LOGS_TIMEOUT_SECONDS=""
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

# load_env_file FILE — export INGRESS_DIAG_* settings from FILE (parsed, never sourced);
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
    [[ "${key}" =~ ^INGRESS_DIAG_[A-Z_]+$ ]] || continue
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

# container_names NAME VALUE — print VALUE, or fail unless it is space-separated docker names.
container_names() {
  local name="$1" value="$2"
  [[ "${value}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*([[:space:]]+[A-Za-z0-9][A-Za-z0-9_.-]*)*$ ]] ||
    fail "${name} must be space-separated container names, got '${value}'"
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
    fail "event time must look like 2026-10-13T05:10:39Z (UTC), got '${time}'"
  awk -v y="${BASH_REMATCH[1]}" -v m="${BASH_REMATCH[2]}" -v d="${BASH_REMATCH[3]}" \
    -v hh="${BASH_REMATCH[4]}" -v mm="${BASH_REMATCH[5]}" -v ss="${BASH_REMATCH[6]}" 'BEGIN {
      y += 0; m += 0; d += 0
      if (m <= 2) y -= 1
      era = int(y / 400); yoe = y - era * 400
      mp = (m + 9) % 12
      doy = int((153 * mp + 2) / 5) + d - 1
      doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
      days = era * 146097 + doe - 719468
      printf "%d", days * 86400 + hh * 3600 + mm * 60 + ss }'
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

# json_log_window — "from <time>" / "to <time>" of docker json-file log lines on stdin.
json_log_window() {
  awk -F'"time":"' 'NR == 1 {print "from", substr($2, 1, 19)} END {if (NR) print "to  ", substr($2, 1, 19)}'
}

# nginx_status_paths — "<status> <path>" per nginx access line on stdin (query string dropped).
nginx_status_paths() {
  awk '$9 ~ /^[0-9]+$/ {split($7, p, "?"); print $9, p[1]}'
}

# nginx_upstream_errors — "<error> -> <upstream host:port>" per nginx error line on stdin;
# works on raw lines and on docker json-file lines (escaped quotes).
nginx_upstream_errors() {
  awk 'match($0, /upstream timed out|connect\(\) failed|recv\(\) failed|could not be resolved/) {
         error = substr($0, RSTART, RLENGTH); upstream = "-"
         if (match($0, /upstream: \\?"https?:\/\/[^\/"\\]+/)) { upstream = substr($0, RSTART, RLENGTH); sub(/.*:\/\//, "", upstream) }
         print error " -> " upstream }'
}

# count_ranked LIMIT — "<count> <line>" for the LIMIT most frequent lines on stdin.
count_ranked() {
  sort | uniq -c | sort -rn | head -"$1"
}

# ---------------------------------------------------------------------------------------------
# Steps (read journals, logs, /proc and run read-only commands)
# ---------------------------------------------------------------------------------------------

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --event-time)
        [[ $# -ge 2 ]] || fail "--event-time needs a UTC time like 2026-10-13T05:10:39Z"
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

  NGINX_CONTAINER="$(container_names INGRESS_DIAG_NGINX_CONTAINER "${INGRESS_DIAG_NGINX_CONTAINER:-${DEFAULT_NGINX_CONTAINER}}")" || exit
  SOCKET_CONTAINERS="$(container_names INGRESS_DIAG_SOCKET_CONTAINERS "${INGRESS_DIAG_SOCKET_CONTAINERS:-${DEFAULT_SOCKET_CONTAINERS}}")" || exit
  UPSTREAM_CONTAINERS="$(container_names INGRESS_DIAG_UPSTREAM_CONTAINERS "${INGRESS_DIAG_UPSTREAM_CONTAINERS:-${DEFAULT_UPSTREAM_CONTAINERS}}")" || exit
  REDIS_SERVICE="$(container_names INGRESS_DIAG_REDIS_SERVICE "${INGRESS_DIAG_REDIS_SERVICE:-${DEFAULT_REDIS_SERVICE}}")" || exit
  MINUTES_BEFORE="$(positive_integer INGRESS_DIAG_MINUTES_BEFORE "${INGRESS_DIAG_MINUTES_BEFORE:-${DEFAULT_MINUTES_BEFORE}}")" || exit
  MINUTES_AFTER="$(positive_integer INGRESS_DIAG_MINUTES_AFTER "${INGRESS_DIAG_MINUTES_AFTER:-${DEFAULT_MINUTES_AFTER}}")" || exit
  NGINX_TAIL_LINES="$(positive_integer INGRESS_DIAG_NGINX_TAIL_LINES "${INGRESS_DIAG_NGINX_TAIL_LINES:-${DEFAULT_NGINX_TAIL_LINES}}")" || exit
  COMMAND_TIMEOUT_SECONDS="$(positive_integer INGRESS_DIAG_COMMAND_TIMEOUT_SECONDS "${INGRESS_DIAG_COMMAND_TIMEOUT_SECONDS:-${DEFAULT_COMMAND_TIMEOUT_SECONDS}}")" || exit
  DOCKER_LOGS_TIMEOUT_SECONDS="$(positive_integer INGRESS_DIAG_DOCKER_LOGS_TIMEOUT_SECONDS "${INGRESS_DIAG_DOCKER_LOGS_TIMEOUT_SECONDS:-${DEFAULT_DOCKER_LOGS_TIMEOUT_SECONDS}}")" || exit
  LOG_DIR="${INGRESS_DIAG_LOG_DIR:-${DEFAULT_LOG_DIR}}"
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

# privileged SECONDS COMMAND... — bounded COMMAND as root (sudo unless already root).
privileged() {
  local seconds="$1"
  shift
  if ((EUID == 0)); then
    bounded "${seconds}" "$@"
  else
    bounded "${seconds}" sudo -n "$@"
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
    fail "needs root for journalctl / nsenter / the nginx log file: run 'sudo -v' first, or run with sudo"
}

# resolve_event_epoch — epoch of --event-time, else of the first socket container's StartedAt.
resolve_event_epoch() {
  local started first_container
  if [[ -n "${EVENT_TIME_ARGUMENT}" ]]; then
    iso_to_epoch "${EVENT_TIME_ARGUMENT}"
    return
  fi
  first_container="${SOCKET_CONTAINERS%% *}"
  started="$(bounded "${COMMAND_TIMEOUT_SECONDS}" docker inspect -f '{{.State.StartedAt}}' "${first_container}" 2>/dev/null)" ||
    fail "could not read ${first_container}'s start time; pass --event-time"
  iso_to_epoch "${started%%.*}Z"
}

utc_timestamp() {
  date -u '+%Y%m%dT%H%M%SZ'
}

# open_log_file — create LOG_DIR if needed and print a new, unused log path inside it.
open_log_file() {
  local path
  mkdir -p "${LOG_DIR}" || fail "cannot create log directory ${LOG_DIR}"
  path="${LOG_DIR}/ingress-herd-$(utc_timestamp).log"
  [[ -e "${path}" ]] && path="${LOG_DIR}/ingress-herd-$(utc_timestamp)-$$.log"
  printf '%s' "${path}"
}

print_header() {
  local event_epoch="$1"
  section "HOST"
  printf 'host: %s   now: %s\n' "$(hostname)" "$(date -u '+%F %T UTC')"
  printf 'event: %s   window: %s .. %s\n' "$(epoch_to_iso "${event_epoch}")" \
    "$(journal_time "$((event_epoch - MINUTES_BEFORE * SECONDS_PER_MINUTE))")" \
    "$(journal_time "$((event_epoch + MINUTES_AFTER * SECONDS_PER_MINUTE))")"
}

# print_restart_event EVENT_EPOCH — what restarted Redis and the socket servers around the event.
print_restart_event() {
  local event_epoch="$1" since until redis_pid container
  since="$(journal_time "$((event_epoch - MINUTES_BEFORE * SECONDS_PER_MINUTE))")"
  until="$(journal_time "$((event_epoch + MINUTES_AFTER * SECONDS_PER_MINUTE))")"

  section "A1. ${REDIS_SERVICE}: start time and uptime"
  redis_pid="$(bounded "${COMMAND_TIMEOUT_SECONDS}" pidof "${REDIS_SERVICE}" | awk '{print $1}')"
  if [[ -n "${redis_pid}" ]]; then
    bounded "${COMMAND_TIMEOUT_SECONDS}" ps -o pid,lstart,etime,args -p "${redis_pid}" | cut -c1-120
  else
    printf '%s not running\n' "${REDIS_SERVICE}"
  fi
  bounded "${COMMAND_TIMEOUT_SECONDS}" redis-cli INFO server 2>&1 | grep -E 'uptime_in_seconds|NOAUTH|refused' || true

  section "A2. socket containers: start, previous exit, restarts"
  for container in ${SOCKET_CONTAINERS}; do
    bounded "${COMMAND_TIMEOUT_SECONDS}" docker inspect -f \
      '{{.Name}} started={{.State.StartedAt}} previous_exit={{.State.FinishedAt}} restarts={{.RestartCount}} policy={{.HostConfig.RestartPolicy.Name}}' \
      "${container}" || printf '%s: inspect failed\n' "${container}"
  done

  section "A3. kernel OOM kills in the window"
  privileged "${COMMAND_TIMEOUT_SECONDS}" journalctl -k --since "${since}" --until "${until}" --no-pager |
    grep -iE 'out of memory|killed process|oom-kill' | cut -c1-200 | tail -10

  section "A4. ${REDIS_SERVICE} service log in the window"
  privileged "${COMMAND_TIMEOUT_SECONDS}" journalctl -u "${REDIS_SERVICE}" --since "${since}" --until "${until}" --no-pager |
    cut -c1-200 | tail -15

  section "A5. dockerd log in the window (restart / exit / kill / signal)"
  privileged "${COMMAND_TIMEOUT_SECONDS}" journalctl -u docker --since "${since}" --until "${until}" --no-pager |
    grep -iE 'restart|exit|kill|signal' | cut -c1-200 | tail -15

  section "A6. recent logins"
  bounded "${COMMAND_TIMEOUT_SECONDS}" last -n 10 -F | head -10

  for container in ${SOCKET_CONTAINERS}; do
    section "A7. ${container}: last ${LAST_LINES_BEFORE_RESTART} lines up to the event"
    bounded "${DOCKER_LOGS_TIMEOUT_SECONDS}" docker logs \
      --since "$(epoch_to_iso "$((event_epoch - LAST_LINES_WINDOW_BEFORE_SECONDS))")" \
      --until "$(epoch_to_iso "$((event_epoch + LAST_LINES_WINDOW_AFTER_SECONDS))")" "${container}" 2>&1 |
      grep -v 'refusing its connections' | cut -c1-200 | tail -"${LAST_LINES_BEFORE_RESTART}" ||
      printf '(docker logs timed out or failed)\n'
  done
}

# print_nginx_log_summary — status/path and upstream errors from the END of nginx's json log file.
print_nginx_log_summary() {
  local log_path
  section "B. ${NGINX_CONTAINER} log (last ${NGINX_TAIL_LINES} lines of the json file; dockerd not involved)"
  log_path="$(bounded "${COMMAND_TIMEOUT_SECONDS}" docker inspect -f '{{.LogPath}}' "${NGINX_CONTAINER}")" ||
    { printf '(could not find the log file)\n'; return; }
  privileged "${COMMAND_TIMEOUT_SECONDS}" ls -la "${log_path}"
  printf -- '-- window\n'
  privileged "${COMMAND_TIMEOUT_SECONDS}" tail -n "${NGINX_TAIL_LINES}" "${log_path}" | json_log_window
  printf -- '-- requests by status and path\n'
  privileged "${COMMAND_TIMEOUT_SECONDS}" tail -n "${NGINX_TAIL_LINES}" "${log_path}" | nginx_status_paths | count_ranked 20
  printf -- '-- upstream errors as <error> -> <upstream>\n'
  privileged "${COMMAND_TIMEOUT_SECONDS}" tail -n "${NGINX_TAIL_LINES}" "${log_path}" | nginx_upstream_errors | count_ranked 15
}

# print_nginx_connections — connection table inside nginx's network namespace.
print_nginx_connections() {
  local nginx_pid container
  section "C. ${NGINX_CONTAINER} connections (inside its network namespace)"
  nginx_pid="$(bounded "${COMMAND_TIMEOUT_SECONDS}" docker inspect -f '{{.State.Pid}}' "${NGINX_CONTAINER}")"
  if [[ ! "${nginx_pid}" =~ ^[1-9][0-9]*$ ]]; then
    printf '(could not find the nginx process)\n'
    return
  fi
  printf -- '-- states\n'
  privileged "${COMMAND_TIMEOUT_SECONDS}" nsenter -t "${nginx_pid}" -n ss -tan | awk 'NR > 1 {print $1}' | count_ranked 10
  printf -- '-- ESTABLISHED by peer (the upstream ip:port with the most is the holder)\n'
  privileged "${COMMAND_TIMEOUT_SECONDS}" nsenter -t "${nginx_pid}" -n ss -tan state established |
    awk 'NR > 1 {print $4}' | count_ranked 8
  printf -- '-- upstream container IPs\n'
  for container in ${UPSTREAM_CONTAINERS}; do
    bounded "${COMMAND_TIMEOUT_SECONDS}" docker inspect -f '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "${container}" ||
      printf '%s: inspect failed\n' "${container}"
  done
}

print_leftover_log_readers() {
  section "D. leftover docker logs readers (should be: none)"
  bounded "${COMMAND_TIMEOUT_SECONDS}" pgrep -af 'docker logs' || printf 'none\n'
}

print_report() {
  local event_epoch="$1"
  print_header "${event_epoch}"
  print_restart_event "${event_epoch}"
  print_nginx_log_summary
  print_nginx_connections
  print_leftover_log_readers
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
