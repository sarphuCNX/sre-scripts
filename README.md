# sre-scripts

Standalone operational scripts. Each folder is self-contained: copy it to the machine and run
it there. Nothing to install beyond what the folder's README names (usually bash + mongosh).

| Script | What it does | Needs |
| --- | --- | --- |
| [`whiteboard-v3-items-cleanup/`](whiteboard-v3-items-cleanup/README.md) | Backs up and clears the dangling legacy `flowitems.flow.items` array of one migrated v3 BrightClass whiteboard | bash, mongosh |
| [`host-cpu-diagnose/`](host-cpu-diagnose/README.md) | Read-only snapshot of why a Docker host's CPU/load is high (CPU split, forks, listen drops, reclaim, dockerd, top processes and zombie parents mapped to containers); saves the report to `./logs/` | bash, procps, iproute2, docker CLI |
| [`ingress-herd-diagnose/`](ingress-herd-diagnose/README.md) | Read-only follow-up for a front-door connection herd: what restarted Redis / the socket servers around an event time, and which upstream behind nginx holds the connections (nginx json log file + nginx netns `ss`); saves the report to `./logs/` | bash, procps, iproute2, util-linux, systemd, docker CLI, redis-cli, sudo |
| [`redis-restart-diagnose/`](redis-restart-diagnose/README.md) | Read-only look at why the host Redis restarted: server process and systemd unit, unit and system journals around the restart, Redis config and memory (INFO / CONFIG GET only), Redis's own log in the window, timers and cron; saves the report to `./logs/` | bash, procps, systemd, redis-cli, sudo |

## Conventions

- One folder per script, with its own `README.md`, `.env.example` and `test/`.
- Settings come from a `.env` inside the folder (parsed, never sourced); `.env` is gitignored.
- Scripts that change data take one target per run, export it first, and ask you to confirm.

## Tests

Tests use only node's built-in test runner (Node 20 or newer) and fake mongosh, so they need
no database and no dependencies:

```bash
npm test
```
