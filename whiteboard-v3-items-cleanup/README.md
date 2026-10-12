# whiteboard v3 items cleanup — server script

Backs up and clears the dangling legacy `flowitems.flow.items` array of **one** migrated v3
whiteboard. It needs only **bash** and **mongosh**: no Python, no uv, nothing to install.

## Copy and configure

Copy this whole directory. `run.sh`, `cleanup.js` and `lib/` must stay together.

```bash
cp .env.example .env        # set WB_CLEANUP_MONGO_URI at least
```

| Variable                       | Required | Default                                |
| ------------------------------ | -------- | -------------------------------------- |
| `WB_CLEANUP_MONGO_URI`         | yes      | none                                   |
| `WB_CLEANUP_DATABASE`          | no       | `brightclass_whiteboard`               |
| `WB_CLEANUP_BACKUP_DIR`        | no       | `./output/whiteboard_v3_items_cleanup` |
| `WB_CLEANUP_BACKUP_COLLECTION` | no       | `flowitems_cleanup`                    |

`.env` is parsed, never sourced. A variable already exported in your shell wins over the file.
`WB_CLEANUP_DATABASE` is used only when the URI has no `/<db>` path. The URI is never printed
(only `host:port/db` is shown) and never passed on the mongosh command line, so credentials do
not appear in `ps`; mongosh gets it through its environment.

## Run

```bash
bash run.sh --dry-run       # checks + export only, no database writes
bash run.sh                 # the real run
bash run.sh --env-file /path/to/other.env
```

It asks for the flowId, then:

1. **Checks**, and stops with nothing written if any fails:
   - exactly one `flowitems` document has the flowId
   - `version` is `3`
   - `flow.migratedAt` is set
   - `flowitementryv3` has at least one entry for the flowId
   - `flow.items` is a non-empty array
   - the backup collection has no *different* backup for the flowId. A backup holding exactly
     the current items was left by an interrupted run; it is reused, so re-running is safe.
2. **Exports** the whole `flowitems` document to
   `<WB_CLEANUP_BACKUP_DIR>/<flowId>-<UTC timestamp>.json` (canonical Extended JSON, exact
   BSON types), then reads it back and compares the item count. A dry run stops here.
3. **Asks you to retype the flowId**, after showing the target, `_id`, item and v3 counts.
4. **Re-checks** everything and stops if the document's `_id`, `updatedAt` or any item differs
   from the export file.
5. **Backs up** `{flowId, items}` with `w: "majority"` (or reuses the matching backup). The
   collection and a unique `flowId` index are created if missing; a non-unique `flowId` index
   stops the run. The stored item count is checked on the server.
6. **Clears** `flow.items` to `[]` with `w: "majority"`, only if `_id`, item count and
   `updatedAt` still match. If they don't, or the backup count was wrong, a backup this run
   inserted is deleted and `flow.items` is left as it was.

If the run stops between the backup and the clear (lost connection, killed session), just run
it again: the backup matches the items, so it is reused and the clear is retried.

Exit codes: `0` cleared (or dry run passed), `1` aborted with `flow.items` unchanged, `2`
configuration, mongosh or database error.

## Restoring a flow

Restore only while `flow.items` is still empty, so items added since the cleanup are never
overwritten; then remove the backup so a later cleanup of that flow is not refused. In mongosh:

```js
const FLOW_ID = "<flowId>";
const BACKUP = "flowitems_cleanup"; // or your WB_CLEANUP_BACKUP_COLLECTION
const backup = db.getCollection(BACKUP).findOne({ flowId: FLOW_ID });
const result = db.flowitems.updateOne(
  { flowId: FLOW_ID, version: 3, "flow.items": { $size: 0 } },
  { $set: { "flow.items": backup.items, updatedAt: new Date() } },
  { writeConcern: { w: "majority" } }
);
printjson(result); // matchedCount: 1 means restored; 0 means flow.items is no longer empty
if (result.modifiedCount === 1) {
  db.getCollection(BACKUP).deleteOne({ _id: backup._id }, { writeConcern: { w: "majority" } });
}
```

If `matchedCount` is 0, the flow has new items; merge by hand instead of overwriting them.

## Files

| File                 | Role                                                                  |
| -------------------- | --------------------------------------------------------------------- |
| `run.sh`             | reads `.env`, prompts, confirms, runs the two mongosh phases          |
| `cleanup.js`         | mongosh entry point: connects, hands mongosh's globals to `lib/`      |
| `lib/main.js`        | reads the phase settings, runs the phase, maps the outcome to a code  |
| `lib/phases.js`      | the two phases: check + export, then re-check + back up + clear       |
| `lib/checks.js`      | pure checks: is the flow eligible, is a document unchanged            |
| `lib/store.js`       | every database call, awaited                                          |
| `lib/export-file.js` | writes and reads the canonical Extended JSON export                   |
| `lib/settings.js`    | validates the `WB_CLEANUP_*` variables run.sh hands over              |
| `lib/errors.js`      | the `Aborted` error and exit codes                                    |
| `.env.example`       | settings template                                                     |
