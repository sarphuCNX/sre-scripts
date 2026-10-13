# ingress-herd-diagnose — server script

A read-only look at a **front-door connection herd** (panels reconnecting through cloudflared → docker-proxy → nginx). It answers two questions:

1. **What restarted the socket servers?** It checks Redis's start time, kernel OOM kills, the Redis and dockerd journals, recent logins, and the socket servers' last log lines before the restart.
2. **Which upstream is holding the connections?** It reads nginx's requests and upstream errors from the end of its json log file, and the established connections per upstream inside nginx's network namespace.

Run [`host-cpu-diagnose`](../host-cpu-diagnose/README.md) first. If it shows `docker-proxy` / `cloudflared` CPU, ListenDrops/s and CLOSE-WAIT on :6080, run this one. It was written for the bc-hetzner incidents of 2026-09-03 and 2026-10-13.

Needs bash, procps, iproute2 (`ss`), util-linux (`nsenter`, `last`), systemd (`journalctl`), the docker CLI, `redis-cli`, and **sudo** (or run it as root). Nothing to install on Ubuntu.

## Read-only

- **Journals:** `journalctl -k`, `-u redis-server` and `-u docker`, limited to the event window.
- **nginx:** its json log **file** is read with `tail` from the end, not through `docker logs`, so dockerd doesn't scan the log. On 2026-10-13, `docker logs` on nginx timed out twice at 90 s.
- **Connections:** counted with `nsenter -t <nginx pid> -n ss`, which only reads the connection table.
- **Socket servers:** `docker logs --since … --until …` covers just the 2 minutes before the restart, with a timeout. It never uses `-f`.
- **Other commands:** `docker inspect`, `redis-cli INFO server`, `ps`, `last` and `pgrep`.

It starts and stops nothing and changes no settings. The **only** file it writes is its report: `./logs/ingress-herd-<UTC timestamp>.log`.

**Light on a loaded host:**
- It runs at the lowest priority, for its own process only (`nice 19`, `ionice -c2 -n7`).
- Every external command runs under `timeout`, with a hard kill after a grace period.
- Only one run at a time (`flock` on a read-only handle of `run.sh`; exit code `3` if busy).

## Copy and run

```bash
# from your laptop
scp -r ingress-herd-diagnose bc-hetzner:~/scripts/sre-scripts/

# on the host
cd ~/scripts/sre-scripts/ingress-herd-diagnose
sudo -v                                        # once, so the script can use sudo -n
bash run.sh                                    # event = controller-server's last start
bash run.sh --event-time 2026-10-13T05:10:39Z  # or name the event (UTC)
```

No `.env` is needed. To change a default, `cp .env.example .env` and edit it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `INGRESS_DIAG_NGINX_CONTAINER` | `brightclass-nginx` | Container whose log and network namespace are read |
| `INGRESS_DIAG_SOCKET_CONTAINERS` | `controller-server broadcast-server` | Socket servers investigated; the first one's start time is the default event |
| `INGRESS_DIAG_UPSTREAM_CONTAINERS` | `controller-server broadcast-server liveclass-server kneura-web-teach-server-pm2 navneet-web-teach-server` | Upstreams whose IPs are listed |
| `INGRESS_DIAG_REDIS_SERVICE` | `redis-server` | Host Redis process name for `pgrep -o -x` (the server, never a `redis-rdb-bgsave` child); its systemd unit is read from that PID |
| `INGRESS_DIAG_MINUTES_BEFORE` / `_AFTER` | `20` / `10` | Journal window around the event |
| `INGRESS_DIAG_NGINX_TAIL_LINES` | `100000` | Lines read from the end of nginx's log (~1 min of a herd) |
| `INGRESS_DIAG_COMMAND_TIMEOUT_SECONDS` | `30` | Timeout per command |
| `INGRESS_DIAG_DOCKER_LOGS_TIMEOUT_SECONDS` | `90` | Timeout for each `docker logs` |
| `INGRESS_DIAG_LOG_DIR` | `./logs` | Where the report is saved |

Exit codes: `0` report printed, `2` configuration error (bad setting or event time, unknown argument, sudo would prompt), `3` another run is in progress.

## Reading the report

| Section | Look for |
| --- | --- |
| A1 | Redis started at about the event time means it restarted together with the socket servers |
| A2 | `previous_exit` just before `started`, and the restart count |
| A3 | `Killed process … (redis-server)` or a socket server means the kernel OOM killer was the trigger |
| A4 / A5 | How Redis exited (journal of the unit it actually runs under; if it isn't a systemd service, run `redis-restart-diagnose`), and whether dockerd restarted the containers (restart policy) or someone stopped them |
| A6 | An operator login at about the event time suggests a manual restart |
| A7 | The socket servers' last words, e.g. a Redis `ECONNREFUSED` or a crash |
| B | `504` / `499` mean an upstream is holding requests; `101` means websocket churn; `200` on `/socket.io/` means long-polls. `upstream timed out -> ip:port` names the holder |
| C | The upstream `ip:port` with the most ESTABLISHED connections is the holder; map it with the IP list |
| D | Anything but `none` means a `docker logs` reader is still running (the `[d]ocker logs` pattern can't match the check itself) |

## Tests

```bash
npm test        # from the repo root; node's built-in runner, no dependencies
```

The tests source `run.sh` to check each helper. The date arithmetic is checked against values computed independently in Python, including a leap day and the epoch. The tests also run the copied folder end to end with fake `sudo` / `docker` / `journalctl` / `nsenter` / `ss` and a real nginx json log file. They assert that:
- the journal and `docker logs` windows are exact;
- `docker` is only called with `inspect` / `logs`;
- `nsenter` targets nginx's PID;
- nothing but the one log file is written;
- the nginx log is left untouched;
- a busy lock, a sudo password prompt and a malformed event time all stop before writing.
