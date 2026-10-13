# redis-restart-diagnose — server script

A read-only look at **why the host Redis restarted**. On bc-hetzner, a Redis restart crashes `controller-server` and `broadcast-server`: their `RedisClient` has no `'error'` listener. That drops the whole panel fleet at once and starts a front-door connection herd (2026-10-13 incident).

Run it after [`ingress-herd-diagnose`](../ingress-herd-diagnose/README.md) has shown that Redis restarted just before the socket servers. By default it finds the restart time itself, as now minus Redis's `uptime_in_seconds`.

Needs bash, procps (`pgrep`, `ps`), systemd (`systemctl`, `journalctl`), `redis-cli` and **sudo** (or run it as root). Nothing to install on Ubuntu.

## Read-only

The report has six sections:
1. **Process:** the Redis **server** process (`pgrep -o -x redis-server`, so not a `redis-rdb-bgsave` child), its parent, its systemd unit, and the unit's restart properties (`systemctl show`: `Result`, `NRestarts`, `ExecMainStatus`, …).
2. **Unit journal:** limited to 10 min before to 5 min after the restart.
3. **Whole system journal:** 60 s before to 20 s after, to show what else happened (cron, deploys, kernel).
4. **Config:** `redis-cli INFO` and `CONFIG GET` only (`logfile`, `save`, `appendonly`, `maxmemory`, memory peak). It never runs `CONFIG SET`.
5. **Redis's own log:** read with `tail` from the end, keeping only lines whose timestamp falls inside the window.
6. **Schedules:** systemd timers, and active cron lines that mention `redis`.

It starts and stops nothing and changes no settings. The **only** file it writes is its report: `./logs/redis-restart-<UTC timestamp>.log`.

**Light on a loaded host:**
- It runs at the lowest priority, for its own process only (`nice 19`, `ionice -c2 -n7`).
- Every external command runs under `timeout`.
- Only one run at a time (`flock` on a read-only handle of `run.sh`; exit code `3` if busy).

## Copy and run

```bash
# from your laptop
scp -r redis-restart-diagnose bc-hetzner:~/scripts/sre-scripts/

# on the host
cd ~/scripts/sre-scripts/redis-restart-diagnose
sudo -v                                        # once, so the script can use sudo -n
bash run.sh                                    # event = Redis's own start time
bash run.sh --event-time 2026-10-13T05:10:32Z  # or name it (UTC)
```

If Redis needs a password, run `export REDISCLI_AUTH=…` first. `redis-cli` reads it from the environment, and it is never printed.

No `.env` is needed. To change a default, `cp .env.example .env` and edit it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `REDIS_DIAG_REDIS_PROCESS` | `redis-server` | Process name for `pgrep -x` |
| `REDIS_DIAG_REDIS_HOST` / `_PORT` | `127.0.0.1` / `6379` | Where `redis-cli` connects |
| `REDIS_DIAG_UNIT_MINUTES_BEFORE` / `_AFTER` | `10` / `5` | Window for the unit journal and Redis's own log |
| `REDIS_DIAG_SYSTEM_SECONDS_BEFORE` / `_AFTER` | `60` / `20` | Window for the whole system journal |
| `REDIS_DIAG_SYSTEM_JOURNAL_LINES` | `120` | Lines shown from the system journal |
| `REDIS_DIAG_JOURNAL_EXCLUDE` | `refusing its connections` | Fixed text whose journal lines are hidden as noise |
| `REDIS_DIAG_REDIS_LOG_TAIL_LINES` | `200000` | Lines read from the end of Redis's log |
| `REDIS_DIAG_CRON_PATHS` | `/etc/crontab /etc/cron.d /var/spool/cron/crontabs` | Searched for `redis` |
| `REDIS_DIAG_COMMAND_TIMEOUT_SECONDS` | `30` | Timeout per command |
| `REDIS_DIAG_LOG_DIR` | `./logs` | Where the report is saved |

Exit codes: `0` report printed, `2` configuration error (bad setting or event time, unknown argument, sudo would prompt, Redis uptime unreadable without `--event-time`), `3` another run is in progress.

## Reading the report

| Section | Points to |
| --- | --- |
| 1 | `NRestarts` > 0 or `Result=` other than `success` means systemd restarted it after a failure. A parent other than PID 1 means a script or supervisor started it. |
| 2 | `Main process exited, code=killed` / `dumped`, `status=9/KILL` (killed) or `11/SEGV` (crash), or `Stopping` / `Started` (someone or something restarted it) |
| 3 | A cron job, deploy, package upgrade (`unattended-upgrades` restarts services) or kernel message right before the restart |
| 4 | `maxmemory 0` with a peak close to RAM points to memory pressure. `save` rules that fork often add copy-on-write cost |
| 5 | Redis's own reason: `Received SIGTERM` (asked to stop), `Out Of Memory`, a crash report (`=== REDIS BUG REPORT START`), or `Background saving terminated by signal` |
| 6 | A timer or cron job that touches Redis at the restart time |

## Tests

```bash
npm test        # from the repo root; node's built-in runner, no dependencies
```

The tests source `run.sh` to check each helper:
- reading `INFO` with CRLF line endings;
- `CONFIG GET` values, including an empty one;
- the Redis-log time filter, including both window edges.

The filter was mutation-checked: making it keep every line fails two tests.

The end-to-end runs use fake `sudo` / `pgrep` / `ps` / `systemctl` / `journalctl` / `redis-cli`, with a real Redis log and crontab. They assert:
- the exact journal windows;
- `pgrep -o -x` is used;
- `redis-cli` is only called with `INFO` / `CONFIG GET`;
- commented-out cron lines are skipped;
- a non-systemd Redis is handled;
- the default event is now minus uptime;
- the report is the only write;
- a busy lock, a sudo prompt or a malformed event time stop before writing.
