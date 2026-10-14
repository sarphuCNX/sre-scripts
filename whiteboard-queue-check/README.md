# whiteboard-queue-check — server script

A read-only check that the **whiteboard update queue no longer keeps completed jobs** (`kneura-web-teach-server`, BullMQ queue `whiteboard-update-queue`).

Before the fix, every whiteboard save left a completed job in Redis. By 2026-10-13 there were ~9.96M of them (~4 GB), the bc-hetzner host ran out of RAM and Redis restarted. The fix (PR #2651 to production, #2653 to dev) sets `removeOnComplete: { count: 0 }` on the worker, so each job is deleted as it finishes. The backlog is removed separately by `scripts/maintenance/cleanup-whiteboard-completed.js` in that repo.

Needs bash and `redis-cli`. Nothing to install on a host that runs Redis.

## Read-only

It takes two samples of the queue, `WB_QUEUE_CHECK_SAMPLE_SECONDS` apart (default 120). The window is measured with Redis's own clock (`TIME`), the same clock family BullMQ stamps finished jobs with on that host.

It runs only `PING`, `TIME`, `EXISTS`, `ZCARD`, `ZCOUNT`, `LLEN`, `GET`, `HLEN`, `DBSIZE`, `INFO` and `CONFIG GET`. Each is O(1) or O(log n), so it is safe on a set of millions of jobs. It never runs `KEYS` or `SCAN`, never writes and never reads job data. The **only** file it writes is its report: `./logs/whiteboard-queue-<UTC timestamp>.log`.

## Copy and run

```bash
# from your laptop
scp -r whiteboard-queue-check bc-hetzner:~/scripts/sre-scripts/

# on the host
cd ~/scripts/sre-scripts/whiteboard-queue-check
bash run.sh                                     # 127.0.0.1:6379 db 0, samples 120 s apart
bash run.sh --deployed-at 2026-10-13T19:30:00Z  # also count jobs kept since the deploy (UTC)
```

If Redis needs a password, run `export REDISCLI_AUTH=…` first. `redis-cli` reads it from the environment, and it is never printed.

No `.env` is needed. To change a default, `cp .env.example .env` and edit it, or pass another file with `--env-file PATH`. A variable already exported in your shell wins over the file.

| Variable | Default | Meaning |
| --- | --- | --- |
| `WB_QUEUE_CHECK_REDIS_HOST` / `_PORT` / `_DB` | `127.0.0.1` / `6379` / `0` | Where the queue lives |
| `WB_QUEUE_CHECK_SAMPLE_SECONDS` | `120` | Seconds between the two samples. 60 or more always covers one batch-update run |
| `WB_QUEUE_CHECK_DEPLOYED_AT` | unset | UTC time the fix went live; `--deployed-at` wins over it |
| `WB_QUEUE_CHECK_MAX_WAITING` | `1000` | Waiting jobs above this fail the worker check |
| `WB_QUEUE_CHECK_COMMAND_TIMEOUT_SECONDS` | `10` | Timeout per `redis-cli` call |
| `WB_QUEUE_CHECK_LOG_DIR` | `./logs` | Where the report is saved |

Exit codes: `0` PASS (warnings allowed), `1` FAIL, `2` configuration error (bad setting, unknown argument, malformed deploy time, Redis not answering, the queue not in that database, or an error reply such as `NOAUTH`). Nothing is written when Redis doesn't answer or the queue isn't found.

## Reading the report

Section 2 shows each counter at both samples and the change. Section 3 shows Redis memory and how many old completed jobs are still left for the cleanup script. Section 4 holds the checks:

| Check | PASS | FAIL / WARN |
| --- | --- | --- |
| Completed jobs kept in the window | No job that finished after the first sample is in the completed set. **This is the fix.** | FAIL: jobs are still stored, so the fix isn't running. WARN: no saves in a window shorter than 60 s, so it's inconclusive |
| Kept since the deploy (with `--deployed-at`) | No job that finished after the deploy time is kept | FAIL: some were kept, so the old code ran after that time |
| Worker is consuming jobs | Waiting stays under the limit, and new saves don't all pile up in `wait` | FAIL: an empty completed set would mean a stopped worker, not the fix |
| Batch updater scheduled | The every-minute `batch-update` job has a repeat registration | FAIL: whiteboard save times would stop reaching MongoDB |
| Failed jobs | No new failed jobs | WARN only: failed jobs are kept on purpose; read the worker log |
| Eviction policy | `noeviction` | WARN: a job queue must not have its keys evicted |

The completed count itself may still be large while the backlog is being cleaned. What matters is that it doesn't grow, and that nothing new lands in it.

## Tests

```bash
npm test        # from the repo root; node's built-in runner, no dependencies
```

The tests source `run.sh` to check each helper:
- settings validation and the `.env` parser;
- `count_reply` and `TIME` parsing (exact milliseconds, error replies);
- every branch of every check, including the limits.

The end-to-end runs use a fake `redis-cli` that answers each counter from a first/second pair. They assert:
- the default target (`127.0.0.1:6379` db 0), the `.env` next to the script, `--env-file`, and that the shell environment wins;
- the exact `ZCOUNT` ranges for the window and the deploy time;
- that each failure exits `1` and warnings still exit `0`;
- that only read-only commands are sent (`CONFIG` only as `CONFIG GET`);
- that the report is the only write, and that nothing is written when Redis doesn't answer or the queue is missing.
