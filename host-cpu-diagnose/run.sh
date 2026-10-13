#!/usr/bin/env bash
# run.sh — read-only snapshot of WHY a Docker host's CPU / load is high.
#
# Standalone: needs only bash, procps (top, ps), iproute2 (ss) and the docker CLI. Copy this
# folder to the host, then from inside it:
#   bash run.sh        # prints the report (~15 s) and saves it to ./logs/
#
# Usage:
#   bash run.sh [--env-file PATH]
#     --env-file   .env to read (default: .env next to this script, if present)
#   Variables already exported in your shell win over the file.
#
# READ-ONLY on the host: it only reads /proc and /sys, and runs `top -b`, `ss`, `ps` and
# `docker ps`. It signals only its own timed-out children, changes no settings and never runs `docker logs`.
# The ONLY write is its own report: <log dir>/host-cpu-<UTC timestamp>.log
# (log dir default: ./logs, relative to the directory you run it from).
#
# LIGHT ON A LOADED HOST: it lowers its OWN priority (nice 19, best-effort I/O level 7) so
# production always wins, bounds every external command with `timeout` so nothing can hang or
# outlive the run, refuses to start while another run holds the lock (flock on this script,
# no lock file written), and computes rates over the MEASURED window, not the planned one.
#
# Report: CPU split (user/system/iowait/softirq), forks/s, TCP ListenDrops/s, NET_RX softirqs/s,
# connection states on the front-door port, kernel memory-reclaim counters, dockerd's current
# CPU, transparent huge pages, the top processes by CURRENT CPU and the top zombie parents,
# each mapped to its container.
#
# Exit codes: 0 report printed, 2 configuration error, 3 another run is in progress.

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ENV_FILE="${SCRIPT_DIR}/.env"
DEFAULT_SAMPLE_SECONDS=10
DEFAULT_TOP_SAMPLE_SECONDS=5
DEFAULT_TOP_PROCESS_COUNT=15
DEFAULT_ZOMBIE_PARENT_COUNT=5
DEFAULT_FRONT_DOOR_PORT=6080
DEFAULT_DOCKER_TIMEOUT_SECONDS=15
DEFAULT_COMMAND_TIMEOUT_SECONDS=10
DEFAULT_PROC_ROOT="/proc"
DEFAULT_SYS_ROOT="/sys"
DEFAULT_LOG_DIR="./logs"
EXIT_OK=0
EXIT_ERROR=2
EXIT_BUSY=3
NICE_LEVEL=19
IO_PRIORITY_CLASS=2
IO_PRIORITY_LEVEL=7
KILL_GRACE_SECONDS=2
VMSTAT_KEYS='^(pgscan_kswapd|pgscan_direct|pgsteal_kswapd|pgsteal_direct|allocstall[a-z_]*|compact_stall|compact_fail|pgmajfault|workingset_refault_file|thp_fault_alloc|thp_collapse_alloc) '

# Set by load_settings().
ENV_FILE=""
SAMPLE_SECONDS=""
TOP_SAMPLE_SECONDS=""
TOP_PROCESS_COUNT=""
ZOMBIE_PARENT_COUNT=""
FRONT_DOOR_PORT=""
DOCKER_TIMEOUT_SECONDS=""
COMMAND_TIMEOUT_SECONDS=""
PROC_ROOT=""
SYS_ROOT=""
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

# load_env_file FILE — export HOST_CPU_DIAG_* settings from FILE (parsed, never sourced);
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
    [[ "${key}" =~ ^HOST_CPU_DIAG_[A-Z_]+$ ]] || continue
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

# section TITLE — print a report heading.
section() {
  printf '\n===== %s =====\n' "$1"
}

# per_second BEFORE AFTER SECONDS — integer rate of a counter (SECONDS may be fractional).
per_second() {
  awk -v b="$1" -v a="$2" -v s="$3" 'BEGIN {printf "%d", (a - b) / s}'
}

# uptime_seconds UPTIME_FILE — seconds since boot from /proc/uptime.
uptime_seconds() {
  awk '{printf "%s", $1}' "$1" 2>/dev/null
}

# elapsed_seconds BEFORE AFTER PLANNED — measured window in seconds (1 decimal), or PLANNED
# when the measurement is missing or not positive.
elapsed_seconds() {
  awk -v b="$1" -v a="$2" -v planned="$3" 'BEGIN {
    if (b == "" || a == "" || a - b <= 0) printf "%.1f", planned; else printf "%.1f", a - b }'
}

# cgroup_container_id CGROUP_FILE — the 64-hex container id in a /proc/<pid>/cgroup file, or nothing.
cgroup_container_id() {
  grep -oE '[0-9a-f]{64}' "$1" 2>/dev/null | head -1
}

# container_name CONTAINER_ID CONTAINER_LIST — "host" for an empty id, the container name when
# CONTAINER_LIST ("<full id> <name>" lines) has it, else "container:<first 12 of id>".
container_name() {
  local container_id="$1" container_list="$2"
  if [[ -z "${container_id}" ]]; then
    printf 'host'
    return
  fi
  awk -v id="${container_id}" '$1 == id {printf "%s", $2; found = 1} END {if (!found) printf "container:%s", substr(id, 1, 12)}' <<<"${container_list}"
}

# tcp_listen_counters NETSTAT_FILE — "<ListenDrops> <ListenOverflows>" from /proc/net/netstat.
tcp_listen_counters() {
  awk '/^TcpExt:/ {
         if (!seen) { for (i = 2; i <= NF; i++) names[i] = $i; seen = 1; next }
         for (i = 2; i <= NF; i++) { if (names[i] == "ListenDrops") drops = $i; if (names[i] == "ListenOverflows") overflows = $i }
         printf "%d %d", drops, overflows }' "$1"
}

# net_rx_softirqs SOFTIRQS_FILE — NET_RX softirq total across all CPUs.
net_rx_softirqs() {
  awk '$1 == "NET_RX:" {for (i = 2; i <= NF; i++) total += $i; printf "%d", total}' "$1"
}

# fork_total STAT_FILE — processes created since boot, from /proc/stat.
fork_total() {
  awk '$1 == "processes" {printf "%d", $2}' "$1"
}

# cpu_jiffies STAT_FILE — "<user+nice> <system> <idle> <iowait> <softirq>" from /proc/stat.
cpu_jiffies() {
  awk '$1 == "cpu" {printf "%d %d %d %d %d", $2 + $3, $4, $5, $6, $8}' "$1"
}

# process_cpu_ticks PID_STAT_FILE — utime+stime of one process, or 0 when it is gone.
# Fields are counted after the ")" so a command name with spaces cannot shift them.
process_cpu_ticks() {
  local stat
  stat="$(cat "$1" 2>/dev/null)" || { printf '0'; return; }
  awk '{printf "%d", $12 + $13}' <<<"${stat##*) }"
}

# cpu_split BEFORE AFTER — percentage line from two cpu_jiffies samples.
cpu_split() {
  awk -v before="$1" -v after="$2" 'BEGIN {
    split(before, b); split(after, a); total = 0
    for (i = 1; i <= 5; i++) { delta[i] = a[i] - b[i]; total += delta[i] }
    if (total <= 0) { print "cpu split: no CPU time elapsed"; exit }
    printf "cpu split: user %.0f%%  system %.0f%%  idle %.0f%%  iowait %.0f%%  softirq %.0f%%\n",
      100 * delta[1] / total, 100 * delta[2] / total, 100 * delta[3] / total, 100 * delta[4] / total, 100 * delta[5] / total }'
}

# cores_used BEFORE_TICKS AFTER_TICKS TICKS_PER_SECOND SECONDS — CPU cores used, 2 decimals.
cores_used() {
  awk -v b="$1" -v a="$2" -v hz="$3" -v s="$4" 'BEGIN {printf "%.2f", (a - b) / hz / s}'
}

# vmstat_rates BEFORE_TEXT AFTER_TEXT SECONDS — "<counter> <n> /s" lines for matching counters.
vmstat_rates() {
  awk -v s="$3" 'NR == FNR {before[$1] = $2; next} ($1 in before) {printf "%-28s %10d /s\n", $1, ($2 - before[$1]) / s}' \
    <(printf '%s\n' "$1") <(printf '%s\n' "$2")
}

# zombie_parents PS_TEXT LIMIT — "<count> <parent pid>" for the LIMIT parents with most zombies.
# PS_TEXT is `ps -eo ppid=,stat=` output.
zombie_parents() {
  awk '$2 ~ /^Z/ {print $1}' <<<"$1" | sort | uniq -c | sort -rn | head -"$2" | awk '{print $1, $2}'
}

# top_process_rows TOP_TEXT LIMIT — "<pid> <cpu%> <mem%> <command>" from the LAST sample of
# `top -b -n 2` output (the first sample is an average since each process started).
top_process_rows() {
  awk -v limit="$2" '
    /^top -/ { sample++; rows = 0; next }
    sample >= 1 && $1 ~ /^[0-9]+$/ { if (rows < limit) { line[sample, ++rows] = $1 " " $9 " " $10 " " $12; count[sample] = rows } }
    END { for (i = 1; i <= count[sample]; i++) print line[sample, i] }' <<<"$1"
}

# top_summary TOP_TEXT — the header lines (load, tasks, %Cpu, memory) of the LAST top sample.
top_summary() {
  awk '/^top -/ {sample++; n = 0} {if (n < 5) block[sample, ++n] = $0} END {for (i = 1; i <= 5; i++) print block[sample, i]}' <<<"$1"
}

# ---------------------------------------------------------------------------------------------
# Steps (read /proc, /sys and run read-only commands)
# ---------------------------------------------------------------------------------------------

parse_args() {
  while (($# > 0)); do
    case "$1" in
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

  SAMPLE_SECONDS="$(positive_integer HOST_CPU_DIAG_SAMPLE_SECONDS "${HOST_CPU_DIAG_SAMPLE_SECONDS:-${DEFAULT_SAMPLE_SECONDS}}")" || exit
  TOP_SAMPLE_SECONDS="$(positive_integer HOST_CPU_DIAG_TOP_SAMPLE_SECONDS "${HOST_CPU_DIAG_TOP_SAMPLE_SECONDS:-${DEFAULT_TOP_SAMPLE_SECONDS}}")" || exit
  TOP_PROCESS_COUNT="$(positive_integer HOST_CPU_DIAG_TOP_PROCESS_COUNT "${HOST_CPU_DIAG_TOP_PROCESS_COUNT:-${DEFAULT_TOP_PROCESS_COUNT}}")" || exit
  ZOMBIE_PARENT_COUNT="$(positive_integer HOST_CPU_DIAG_ZOMBIE_PARENT_COUNT "${HOST_CPU_DIAG_ZOMBIE_PARENT_COUNT:-${DEFAULT_ZOMBIE_PARENT_COUNT}}")" || exit
  FRONT_DOOR_PORT="$(positive_integer HOST_CPU_DIAG_FRONT_DOOR_PORT "${HOST_CPU_DIAG_FRONT_DOOR_PORT:-${DEFAULT_FRONT_DOOR_PORT}}")" || exit
  DOCKER_TIMEOUT_SECONDS="$(positive_integer HOST_CPU_DIAG_DOCKER_TIMEOUT_SECONDS "${HOST_CPU_DIAG_DOCKER_TIMEOUT_SECONDS:-${DEFAULT_DOCKER_TIMEOUT_SECONDS}}")" || exit
  COMMAND_TIMEOUT_SECONDS="$(positive_integer HOST_CPU_DIAG_COMMAND_TIMEOUT_SECONDS "${HOST_CPU_DIAG_COMMAND_TIMEOUT_SECONDS:-${DEFAULT_COMMAND_TIMEOUT_SECONDS}}")" || exit
  PROC_ROOT="${HOST_CPU_DIAG_PROC_ROOT:-${DEFAULT_PROC_ROOT}}"
  SYS_ROOT="${HOST_CPU_DIAG_SYS_ROOT:-${DEFAULT_SYS_ROOT}}"
  LOG_DIR="${HOST_CPU_DIAG_LOG_DIR:-${DEFAULT_LOG_DIR}}"
  [[ -r "${PROC_ROOT}/stat" ]] || fail "cannot read ${PROC_ROOT}/stat; run this on the Linux host"
}

# utc_timestamp — compact UTC timestamp for file names.
utc_timestamp() {
  date -u '+%Y%m%dT%H%M%SZ'
}

# open_log_file — create LOG_DIR if needed and print a new, unused log path inside it.
open_log_file() {
  local path
  mkdir -p "${LOG_DIR}" || fail "cannot create log directory ${LOG_DIR}"
  path="${LOG_DIR}/host-cpu-$(utc_timestamp).log"
  [[ -e "${path}" ]] && path="${LOG_DIR}/host-cpu-$(utc_timestamp)-$$.log"
  printf '%s' "${path}"
}

# bounded SECONDS COMMAND... — run COMMAND, killed after SECONDS (hard kill KILL_GRACE_SECONDS
# later), so a command stuck on a busy kernel can never hang or outlive this script.
bounded() {
  local seconds="$1"
  shift
  timeout -k "${KILL_GRACE_SECONDS}" "${seconds}" "$@"
}

# lower_own_priority — nice 19 and best-effort I/O level 7 for THIS script (inherited by its
# children). Touches nothing else on the host; silently skipped where unsupported.
lower_own_priority() {
  renice -n "${NICE_LEVEL}" -p "$$" >/dev/null 2>&1 || true
  if command -v ionice >/dev/null 2>&1; then
    ionice -c "${IO_PRIORITY_CLASS}" -n "${IO_PRIORITY_LEVEL}" -p "$$" >/dev/null 2>&1 || true
  fi
}

# acquire_single_run_lock — exit EXIT_BUSY when another run holds the lock. The lock is an
# flock on a READ-ONLY descriptor (fd 9) of this script, so no lock file is written; it is
# released automatically when the script exits.
acquire_single_run_lock() {
  command -v flock >/dev/null 2>&1 || return 0
  exec 9<"${BASH_SOURCE[0]}"
  if ! flock -n 9; then
    printf 'busy: another run.sh is already running on this host; wait for it to finish\n' >&2
    exit "${EXIT_BUSY}"
  fi
}

# list_containers — "<full id> <name>" per running container; empty if docker is unavailable.
list_containers() {
  bounded "${DOCKER_TIMEOUT_SECONDS}" docker ps --no-trunc --format '{{.ID}} {{.Names}}' 2>/dev/null || true
}

# container_for_pid PID CONTAINER_LIST — container name owning PID, or "host".
container_for_pid() {
  container_name "$(cgroup_container_id "${PROC_ROOT}/$1/cgroup")" "$2"
}

print_header() {
  section "HOST"
  printf 'host: %s   time: %s\n' "$(hostname)" "$(date '+%F %T %Z')"
  uptime
  free -h
}

# print_rates — one shared sample window for every counter-based rate.
print_rates() {
  local dockerd_pid ticks_per_second window
  local uptime_before cpu_before forks_before drops_before net_rx_before vm_before dockerd_before
  local uptime_after cpu_after forks_after drops_after net_rx_after vm_after dockerd_after
  dockerd_pid="$(bounded "${COMMAND_TIMEOUT_SECONDS}" pidof dockerd 2>/dev/null | awk '{print $1}')"
  ticks_per_second="$(getconf CLK_TCK)"

  uptime_before="$(uptime_seconds "${PROC_ROOT}/uptime")"
  cpu_before="$(cpu_jiffies "${PROC_ROOT}/stat")"
  forks_before="$(fork_total "${PROC_ROOT}/stat")"
  drops_before="$(tcp_listen_counters "${PROC_ROOT}/net/netstat")"
  net_rx_before="$(net_rx_softirqs "${PROC_ROOT}/softirqs")"
  vm_before="$(grep -E "${VMSTAT_KEYS}" "${PROC_ROOT}/vmstat")"
  dockerd_before="$(process_cpu_ticks "${PROC_ROOT}/${dockerd_pid:-0}/stat")"
  sleep "${SAMPLE_SECONDS}"
  uptime_after="$(uptime_seconds "${PROC_ROOT}/uptime")"
  cpu_after="$(cpu_jiffies "${PROC_ROOT}/stat")"
  forks_after="$(fork_total "${PROC_ROOT}/stat")"
  drops_after="$(tcp_listen_counters "${PROC_ROOT}/net/netstat")"
  net_rx_after="$(net_rx_softirqs "${PROC_ROOT}/softirqs")"
  vm_after="$(grep -E "${VMSTAT_KEYS}" "${PROC_ROOT}/vmstat")"
  dockerd_after="$(process_cpu_ticks "${PROC_ROOT}/${dockerd_pid:-0}/stat")"

  window="$(elapsed_seconds "${uptime_before}" "${uptime_after}" "${SAMPLE_SECONDS}")"

  section "RATES over ${window}s (measured; planned ${SAMPLE_SECONDS}s)"
  cpu_split "${cpu_before}" "${cpu_after}"
  printf 'forks/s: %s\n' "$(per_second "${forks_before}" "${forks_after}" "${window}")"
  printf 'tcp ListenDrops/s: %s   ListenOverflows/s: %s\n' \
    "$(per_second "${drops_before% *}" "${drops_after% *}" "${window}")" \
    "$(per_second "${drops_before#* }" "${drops_after#* }" "${window}")"
  printf 'NET_RX softirqs/s: %s\n' "$(per_second "${net_rx_before}" "${net_rx_after}" "${window}")"
  if [[ -n "${dockerd_pid}" ]]; then
    printf 'dockerd cores: %s\n' "$(cores_used "${dockerd_before}" "${dockerd_after}" "${ticks_per_second}" "${window}")"
  else
    printf 'dockerd cores: dockerd not found\n'
  fi
  printf -- '-- kernel memory counters (non-zero allocstall / compact_stall = kernel fighting for memory)\n'
  vmstat_rates "${vm_before}" "${vm_after}" "${window}"
}

print_front_door_connections() {
  section "CONNECTIONS on :${FRONT_DOOR_PORT} (state counts)"
  local summary states
  if summary="$(bounded "${COMMAND_TIMEOUT_SECONDS}" ss -s)"; then
    head -2 <<<"${summary}"
  else
    printf '(ss -s timed out or failed)\n'
  fi
  if states="$(bounded "${COMMAND_TIMEOUT_SECONDS}" ss -tan "( sport = :${FRONT_DOOR_PORT} )")"; then
    awk 'NR > 1 {print $1}' <<<"${states}" | sort | uniq -c | sort -rn
  else
    printf '(ss timed out or failed)\n'
  fi
}

print_transparent_huge_pages() {
  section "TRANSPARENT HUGE PAGES"
  printf 'enabled: %s\n' "$(cat "${SYS_ROOT}/kernel/mm/transparent_hugepage/enabled" 2>/dev/null)"
  printf 'defrag:  %s\n' "$(cat "${SYS_ROOT}/kernel/mm/transparent_hugepage/defrag" 2>/dev/null)"
}

print_top_processes() {
  local container_list="$1" top_text pid cpu mem command
  top_text="$(bounded "$((TOP_SAMPLE_SECONDS + COMMAND_TIMEOUT_SECONDS))" top -b -n 2 -d "${TOP_SAMPLE_SECONDS}" -o %CPU -w 512)"
  section "CURRENT CPU (top, 2nd sample over ${TOP_SAMPLE_SECONDS}s) + container"
  if [[ -z "${top_text}" ]]; then
    printf '(top timed out or failed)\n'
    return
  fi
  top_summary "${top_text}"
  printf '%-8s %6s %6s  %-32s %s\n' PID CPU% MEM% CONTAINER COMMAND
  while read -r pid cpu mem command; do
    [[ -n "${pid}" ]] || continue
    printf '%-8s %6s %6s  %-32s %s\n' "${pid}" "${cpu}" "${mem}" "$(container_for_pid "${pid}" "${container_list}")" "${command}"
  done <<<"$(top_process_rows "${top_text}" "${TOP_PROCESS_COUNT}")"
}

# parent_description PID — elapsed time and command line of PID, or a timeout note.
parent_description() {
  local description
  if description="$(bounded "${COMMAND_TIMEOUT_SECONDS}" ps -o etime=,args= -p "$1")"; then
    printf '%s' "${description:0:100}"
  else
    printf '(ps timed out or process gone)'
  fi
}

print_zombie_parents() {
  local container_list="$1" ps_text count parent_pid
  section "ZOMBIE PARENTS (top ${ZOMBIE_PARENT_COUNT}) + container"
  if ! ps_text="$(bounded "${COMMAND_TIMEOUT_SECONDS}" ps -eo ppid=,stat=)"; then
    printf '(ps timed out or failed)\n'
    return
  fi
  printf 'total zombies: %s\n' "$(awk '$2 ~ /^Z/' <<<"${ps_text}" | wc -l | tr -d ' ')"
  while read -r count parent_pid; do
    [[ -n "${parent_pid}" ]] || continue
    printf '%5s zombies  parent %-8s %-32s %s\n' "${count}" "${parent_pid}" \
      "$(container_for_pid "${parent_pid}" "${container_list}")" \
      "$(parent_description "${parent_pid}")"
  done <<<"$(zombie_parents "${ps_text}" "${ZOMBIE_PARENT_COUNT}")"
}

print_report() {
  local container_list
  container_list="$(list_containers)"
  print_header
  print_rates
  print_front_door_connections
  print_transparent_huge_pages
  print_top_processes "${container_list}"
  print_zombie_parents "${container_list}"
}

main() {
  local log_file
  parse_args "$@"
  load_settings
  acquire_single_run_lock
  lower_own_priority
  log_file="$(open_log_file)" || exit
  print_report 2>&1 | tee "${log_file}"
  printf '\nsaved: %s\n' "${log_file}"
  exit "${EXIT_OK}"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
