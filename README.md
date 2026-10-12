# sre-scripts

Standalone operational scripts. Each folder is self-contained: copy it to the machine and run
it there. Nothing to install beyond what the folder's README names (usually bash + mongosh).

| Script | What it does | Needs |
| --- | --- | --- |
| [`whiteboard-v3-items-cleanup/`](whiteboard-v3-items-cleanup/README.md) | Backs up and clears the dangling legacy `flowitems.flow.items` array of one migrated v3 BrightClass whiteboard | bash, mongosh |

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
