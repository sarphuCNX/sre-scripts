# container-events-diagnose — server script

A read-only **timeline of one container's stops and starts**, next to what host load and CPU did over the same window. Use it to record exactly when a container was stopped, crashed or started, and to show the effect. For example: on 2026-10-13 `controller-server` was stopped to relieve a connection herd on bc-hetzner, and the CPU came down.

Needs bash, the docker CLI, systemd (`journalctl`), sysstat (`sar`) and **sudo** (or run it as root). Nothing to install on Ubuntu with sysstat enabled.

## Read-only

The report has seven sections:
1. **State:** `docker inspect`: status now, last `started`, last `finished` (stop or crash), exit code, OOM flag, restart count, restart policy.
2. **Docker events:** `docker events --since … --until <now>` for that container, lifecycle actions only (`kill`, `die`, `stop`, `start`, `oom`, …) with UTC times and exit codes. Passing `--until` makes it a finite query, never a live stream. Docker keeps only a limited event history, so an empty list doesn't prove nothing happened.
3. **dockerd journal:** lines for the window that mention the container's exact name or short id, e.g. `Container failed to exit within 10s of signal 15`.
4. **Shell history:** `stop` / `start` / `restart` / `kill` / `rm` / `up` / `down` commands that name **exactly** that container. `controller-server` doesn't match `navneet-controller-server` or `controller-server-old`. Bash history has no timestamps, so use 1–3 for times.
5. **Load average:** `sar -q` from the start of the window.
6. **CPU:** `sar -u` from the start of the window (user / system / idle).
7. **Now:** `uptime` and the container's current status.

It starts and stops nothing and changes no settings. The **only** file it writes is its report: `./logs/container-events-<UTC timestamp>.log`.

**Light on a loaded host:**
- It runs at the lowest priority, for its own process only (`nice 19`, `ionice -c2 -n7`).
- Every external command runs under `timeout`.
- Only one run at a time (`flock` on a read-only handle of `run.sh`; exit code `3` if busy).

## Copy and run

```bash
# from your laptop
scp -r container-events-diagnose bc-hetzner:~/scripts/sre-scripts/

# on the host
cd ~/scripts/sre-scripts/container-events-diagnose
sudo -v                                                     # once, so the script can use sudo -n
bash run.sh                                                 # controller-server, last 6 hours
bash run.sh --since 2026-10-13T05:00:00Z                    # from a given time (UTC) until now
bash run.sh --container liveclass-server --since 2026-10-13T05:00:00Z
```

`sar` reads one day's file. If `--since` is on an earlier day than today (UTC), sections 5–6 cover today from midnight; their section titles show the start time used (`from 00:00:00 UTC`).

No `.env` is needed. To change a default, `cp .env.example .env` and edit it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONTAINER_DIAG_CONTAINER` | `controller-server` | Container to follow (`--container` wins) |
| `CONTAINER_DIAG_WINDOW_HOURS` | `6` | Window when `--since` isn't given |
| `CONTAINER_DIAG_HISTORY_FILES` | `/root/.bash_history /home/*/.bash_history` | Shell history files searched |
| `CONTAINER_DIAG_JOURNAL_LINES` | `40` | dockerd journal lines shown |
| `CONTAINER_DIAG_COMMAND_TIMEOUT_SECONDS` | `30` | Timeout per command |
| `CONTAINER_DIAG_LOG_DIR` | `./logs` | Where the report is saved |

Exit codes: `0` report printed, `2` configuration error (bad or unsafe container name, malformed or future `--since`, unknown argument, sudo would prompt), `3` another run is in progress.

## Reading the report

| Section | Look for |
| --- | --- |
| 1 | `status=exited` means it's still stopped. `finished=` is the last stop or crash; `exit=137` means it was killed (`docker stop` after 10 s, or the OOM killer if `oom=true`); `exit=0` means a clean stop |
| 2 | The `kill` → `die` → `start` sequence with exact times. `die` without a preceding `kill` / `stop` means it crashed |
| 3 | dockerd's view of the stop (`failed to exit within 10s … using the force`) and any restarts |
| 4 | Who stopped or started it (no times) |
| 5 / 6 | `ldavg-1` and `%system` in the 10-minute samples before and after the stop. A sharp drop right after shows the stop relieved the host |
| 7 | Whether load stayed down, and whether the container is back |

## Tests

```bash
npm test        # from the repo root; node's built-in runner, no dependencies
```

The tests source `run.sh` to check each helper:
- exact-name matching, including dot escaping;
- UTC time conversion;
- the `sar` start time for a window that starts today and for one that starts yesterday.

Exact-name matching was mutation-checked: replacing it with a plain substring match fails the three tests that depend on it.

The end-to-end runs use fake `sudo` / `docker` / `journalctl` / `sar`, with a real shell history file. They assert:
- `docker events` gets a finite `--since … --until` window;
- only lifecycle events are listed, with UTC times;
- the journal window is exact;
- lines about `navneet-controller-server` are dropped;
- only exact-name history commands are listed;
- `docker` is only called with `inspect` / `events` / `ps`;
- the report is the only write;
- a busy lock, a sudo prompt, or a future, malformed or unsafe argument stops before writing.
