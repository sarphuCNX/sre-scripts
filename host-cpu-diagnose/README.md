# host-cpu-diagnose — server script

A read-only, ~15-second snapshot of **why** a Docker host's CPU or load is high. Every PID in the report is mapped to its container. It needs only **bash**, **procps** (`top`, `ps`), **iproute2** (`ss`) and the **docker** CLI. Nothing to install.

Written for the bc-hetzner (`BrightClass-Production`) load incidents. Its checks cover the causes found there before:
- memory reclaim;
- process-spawn churn;
- dockerd log readers (2026-09-01);
- held connections on the front door (2026-09-03);
- Puppeteer zombie leaks.

## Read-only

On the host it only reads `/proc` and `/sys`, and runs `top -b`, `ss`, `ps` and `docker ps` (with a timeout). It never runs `docker logs`, never sends a signal and never changes a setting.

The **only** file it writes is its own report: `./logs/host-cpu-<UTC timestamp>.log`, relative to the directory you run it from.

## Light on a loaded host

It's built to run while the host is at load 100+ without adding to the problem:

- **Lowest priority, for itself only.** It renices its own process to `nice 19` and sets best-effort I/O level 7 (`ionice -c2 -n7`). Production always wins the CPU. Nothing else on the host is touched.
- **Every external command is time-limited.** `top`, `ss`, `ps`, `pidof` and `docker ps` each run under `timeout` (default 10 s, then a hard kill 2 s later). A command stuck on a busy kernel can't hang the run or outlive it; the report notes `(… timed out)` instead.
- **One run at a time.** A second run exits with code `3` while the first is still going. The lock is an `flock` on a read-only handle of `run.sh`, so no lock file is written.
- **Rates use the measured window.** On a starved CPU, `sleep 10` can take longer. The script reads `/proc/uptime` before and after and divides by the real time, shown as `RATES over 10.8s (measured; planned 10s)`.

Cost per run: about 15 s, mostly sleeping, and about 60 short processes (one `docker ps`, one `top`, two `ss`, up to six `ps`).

## Copy and run

Copy this whole folder to the host and run it from inside the folder:

```bash
# from your laptop
scp -r host-cpu-diagnose bc-hetzner:~/scripts_EC2/

# on the host
cd ~/scripts_EC2/host-cpu-diagnose
bash run.sh                 # prints the report and saves it to ./logs/
```

No `.env` is needed. To change a default, `cp .env.example .env` and edit it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST_CPU_DIAG_SAMPLE_SECONDS` | `10` | Window for counter rates |
| `HOST_CPU_DIAG_TOP_SAMPLE_SECONDS` | `5` | Gap between the two `top` samples |
| `HOST_CPU_DIAG_TOP_PROCESS_COUNT` | `15` | Processes listed by current CPU |
| `HOST_CPU_DIAG_ZOMBIE_PARENT_COUNT` | `5` | Zombie parents listed |
| `HOST_CPU_DIAG_FRONT_DOOR_PORT` | `6080` | Port whose TCP states are counted |
| `HOST_CPU_DIAG_DOCKER_TIMEOUT_SECONDS` | `15` | Timeout for `docker ps` |
| `HOST_CPU_DIAG_COMMAND_TIMEOUT_SECONDS` | `10` | Timeout for `ss`, `ps`, `pidof` (for `top`: added to its sample time) |
| `HOST_CPU_DIAG_LOG_DIR` | `./logs` | Where the report is saved |

`HOST_CPU_DIAG_PROC_ROOT` and `HOST_CPU_DIAG_SYS_ROOT` exist only for the tests.

Exit codes: `0` report printed, `2` configuration error (bad setting, unknown argument, no `/proc`), `3` another run is in progress.

## Reading the report

| Line | Points to | Seen before |
| --- | --- | --- |
| `cpu split` with high `system` | Kernel work. Read the lines below to see which kind | 62–79% system on 2026-10-13 |
| `forks/s` in the hundreds or more | Process-spawn churn (healthchecks, `exec` loops) | 6/s on 2026-10-13 (ruled out) |
| `tcp ListenDrops/s` in the thousands, many `ESTAB` / `SYN-RECV` on :6080 | Held connections / reconnect herd through docker-proxy | ~9,600/s, 12k–24k ESTAB on 2026-09-03 |
| `NET_RX softirqs/s` in the tens of thousands | Network interrupt load | ~30,000/s on 2026-09-03 |
| `allocstall_*` / `compact_stall` above 0 every second, high `pgscan_*` | Kernel fighting for memory | |
| `dockerd cores` above ~0.5 | Orphaned `docker logs` readers | 4.9 cores on 2026-09-01 |
| `CURRENT CPU` table | Which process / container is busy **now** (unlike the lifetime average that `ps %cpu` shows) | |
| `ZOMBIE PARENTS` | A container whose PID 1 doesn't reap children; fix with `init: true` | `navneet-media-converter-server`, `einsos-digitalme-server` |

## Tests

```bash
npm test        # from the repo root; node's built-in runner, no dependencies
```

The tests source `run.sh` to check each helper function. They also run the copied folder end to end against a fake `/proc`, a fake `/sys`, and fake `top` / `ss` / `ps` / `docker`. Among other things, they assert that:
- `docker` is only ever called with `ps`;
- nothing but the one log file is written;
- the script lowers its own priority;
- a second concurrent run is refused;
- a hung `ps` can't stall the run;
- rates use the measured window.
