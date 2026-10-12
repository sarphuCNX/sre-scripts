'use strict';
/** Unit tests for lib/ against the async in-memory fake database. Run: node --test */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const LIB = path.resolve(__dirname, '../lib');
const { checkEligibility, sameFlowState } = require(`${LIB}/checks.js`);
const { Aborted, EXIT_ABORTED, EXIT_ERROR, EXIT_OK } = require(`${LIB}/errors.js`);
const { readExport, writeExport } = require(`${LIB}/export-file.js`);
const { main } = require(`${LIB}/main.js`);
const { apply, checkAndExport } = require(`${LIB}/phases.js`);
const { readSettings } = require(`${LIB}/settings.js`);
const { FlowStore } = require(`${LIB}/store.js`);
const { FAKE_EJSON, FakeDatabase, FakeMongo } = require('./fakes/fake-db.js');

const FLOW_ID = '3853af3f-761e-412d-b84a-dbc26eddeffe';
const DOCUMENT_ID = 'doc-1';
const UPDATED_AT = '2026-10-12T04:00:00.000Z';
const BACKUP = 'flowitems_cleanup';
const V3_ENTRY_COUNT = 5;
const ORIGINAL_ITEMS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

// --- builders ---------------------------------------------------------------------------------

function flowDocument(overrides = {}) {
  const { flow: flowOverrides, ...rest } = overrides;
  return {
    _id: DOCUMENT_ID,
    flowId: FLOW_ID,
    version: 3,
    updatedAt: UPDATED_AT,
    ...rest,
    flow: { migratedAt: '2026-06-01T10:00:00.000Z', items: structuredClone(ORIGINAL_ITEMS), ...flowOverrides },
  };
}

function databaseWith({ documents = [flowDocument()], v3Count = V3_ENTRY_COUNT, backups, indexes, faults = {} } = {}) {
  const collections = {
    flowitems: documents,
    flowitementryv3: Array.from({ length: v3Count }, (_, index) => ({ flowId: FLOW_ID, n: index })),
  };
  if (backups) {
    collections[BACKUP] = backups;
  }
  return new FakeDatabase({ collections, indexes: indexes || {}, faults });
}

function exportPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cleanup-')), `${FLOW_ID}.json`);
}

function deps(database, printed = []) {
  return { store: new FlowStore(database, BACKUP), fs, EJSON: FAKE_EJSON, print: (line) => printed.push(line) };
}

/** Export the current document the way phase 1 does, and return its path. */
async function exportedFile(database) {
  const exportFile = exportPath();
  await checkAndExport(deps(database), { flowId: FLOW_ID, exportFile });
  return exportFile;
}

function legacyItems(database) {
  return database.state.collections.flowitems[0].flow.items;
}

// --- checks.js --------------------------------------------------------------------------------

test('checkEligibility with a valid flow returns its facts', () => {
  const documents = [flowDocument()];

  const eligible = checkEligibility(FLOW_ID, documents, V3_ENTRY_COUNT);

  assert.deepEqual(eligible, { documentId: DOCUMENT_ID, itemCount: 3, v3EntryCount: V3_ENTRY_COUNT });
});

const INELIGIBLE_CASES = [
  ['no documents', [], V3_ENTRY_COUNT, /no flowitems document/],
  ['two documents', [flowDocument(), flowDocument()], V3_ENTRY_COUNT, /expected exactly 1/],
  ['missing version', [flowDocument({ version: undefined })], V3_ENTRY_COUNT, /expected 3/],
  ['version 1', [flowDocument({ version: 1 })], V3_ENTRY_COUNT, /expected 3/],
  ['version "3" as a string', [flowDocument({ version: '3' })], V3_ENTRY_COUNT, /expected 3/],
  ['no flow object', [{ _id: DOCUMENT_ID, flowId: FLOW_ID, version: 3 }], V3_ENTRY_COUNT, /no 'flow' object/],
  ['no migratedAt', [flowDocument({ flow: { migratedAt: undefined } })], V3_ENTRY_COUNT, /not migrated/],
  ['zero v3 entries', [flowDocument()], 0, /no flowitementryv3 entries/],
  ['items not an array', [flowDocument({ flow: { items: { 0: 'a' } } })], V3_ENTRY_COUNT, /no flow.items array/],
  ['empty items', [flowDocument({ flow: { items: [] } })], V3_ENTRY_COUNT, /empty flow.items/],
];

for (const [name, documents, v3Count, message] of INELIGIBLE_CASES) {
  test(`checkEligibility with ${name} throws Aborted`, () => {
    assert.throws(
      () => checkEligibility(FLOW_ID, documents, v3Count),
      (error) => error instanceof Aborted && message.test(error.message)
    );
  });
}

test('sameFlowState is true for an unchanged document', () => {
  const document = flowDocument();

  const same = sameFlowState(FAKE_EJSON, document, flowDocument());

  assert.equal(same, true);
});

test('sameFlowState detects an item edited in place with the same count and updatedAt', () => {
  const edited = flowDocument({ flow: { items: [{ id: 'edited' }, { id: 'b' }, { id: 'c' }] } });

  const same = sameFlowState(FAKE_EJSON, edited, flowDocument());

  assert.equal(same, false);
});

test('sameFlowState detects a changed updatedAt', () => {
  const touched = flowDocument({ updatedAt: '2026-10-12T05:00:00.000Z' });

  const same = sameFlowState(FAKE_EJSON, touched, flowDocument());

  assert.equal(same, false);
});

test('sameFlowState treats a missing updatedAt like null', () => {
  const { updatedAt, ...withoutUpdatedAt } = flowDocument();

  const same = sameFlowState(FAKE_EJSON, withoutUpdatedAt, { ...withoutUpdatedAt, updatedAt: null });

  assert.equal(same, true);
});

// --- settings.js ------------------------------------------------------------------------------

function environment(overrides = {}) {
  return {
    WB_CLEANUP_PHASE: 'check-export',
    WB_CLEANUP_FLOW_ID: FLOW_ID,
    WB_CLEANUP_EFFECTIVE_DATABASE: 'brightclass_whiteboard',
    WB_CLEANUP_BACKUP_COLLECTION: BACKUP,
    WB_CLEANUP_EXPORT_FILE: '/exports/flow.json',
    ...overrides,
  };
}

test('readSettings returns the validated settings', () => {
  const env = environment();

  const settings = readSettings(env);

  assert.deepEqual(settings, {
    phase: 'check-export',
    flowId: FLOW_ID,
    database: 'brightclass_whiteboard',
    backupCollection: BACKUP,
    exportFile: '/exports/flow.json',
  });
});

for (const [name, overrides, message] of [
  ['an unsafe flowId', { WB_CLEANUP_FLOW_ID: '{"$ne":null}' }, /may only contain/],
  ['an unknown phase', { WB_CLEANUP_PHASE: 'drop' }, /unknown WB_CLEANUP_PHASE/],
  ['a missing export file', { WB_CLEANUP_EXPORT_FILE: '' }, /WB_CLEANUP_EXPORT_FILE is not set/],
  ['flowitems as the backup collection', { WB_CLEANUP_BACKUP_COLLECTION: 'flowitems' }, /source collection/],
  ['flowitementryv3 as the backup collection', { WB_CLEANUP_BACKUP_COLLECTION: 'flowitementryv3' }, /source collection/],
  ['a system.* backup collection', { WB_CLEANUP_BACKUP_COLLECTION: 'system.profile' }, /not a usable/],
  ['a backup collection with $', { WB_CLEANUP_BACKUP_COLLECTION: 'flow$items' }, /not a usable/],
]) {
  test(`readSettings rejects ${name}`, () => {
    assert.throws(() => readSettings(environment(overrides)), message);
  });
}

// --- export-file.js ---------------------------------------------------------------------------

test('writeExport writes the document and leaves no temporary file', () => {
  const exportFile = exportPath();

  writeExport({ fs, EJSON: FAKE_EJSON }, flowDocument(), exportFile);

  assert.deepEqual([readExport({ fs, EJSON: FAKE_EJSON }, exportFile), fs.existsSync(`${exportFile}.tmp`)], [flowDocument(), false]);
});

test('writeExport asks EJSON for canonical output', () => {
  const options = [];
  const recordingEjson = { stringify: (value, replacer, space, option) => (options.push(option), JSON.stringify(value)), parse: JSON.parse };

  writeExport({ fs, EJSON: recordingEjson }, flowDocument(), exportPath());

  assert.deepEqual(options, [{ relaxed: false }]);
});

test('writeExport refuses to overwrite an existing file', () => {
  const exportFile = exportPath();
  fs.writeFileSync(exportFile, 'earlier export');

  assert.throws(() => writeExport({ fs, EJSON: FAKE_EJSON }, flowDocument(), exportFile), /already exists/);
  assert.equal(fs.readFileSync(exportFile, 'utf8'), 'earlier export');
});

test('writeExport rejects a read-back with a different item count', () => {
  const truncatingEjson = { stringify: (value) => JSON.stringify({ ...value, flow: { items: [] } }), parse: JSON.parse };

  assert.throws(() => writeExport({ fs, EJSON: truncatingEjson }, flowDocument(), exportPath()), /different flow.items count/);
});

test('readExport of a missing file throws Aborted', () => {
  const missing = exportPath();

  assert.throws(() => readExport({ fs, EJSON: FAKE_EJSON }, missing), (error) => error instanceof Aborted);
});

// --- store.js ---------------------------------------------------------------------------------

test('FlowStore.countV3Entries passes the limit through', async () => {
  const store = new FlowStore(databaseWith(), BACKUP);

  const count = await store.countV3Entries(FLOW_ID, { limit: 1 });

  assert.equal(count, 1);
});

test('FlowStore.ensureBackupIndex creates a unique flowId index on a new collection', async () => {
  const database = databaseWith();

  await new FlowStore(database, BACKUP).ensureBackupIndex();

  assert.deepEqual(database.state.indexes[BACKUP], [{ key: { flowId: 1 }, name: 'flowId_unique', unique: true }]);
});

test('FlowStore.ensureBackupIndex keeps an existing unique flowId index under any name', async () => {
  const existing = [{ key: { flowId: 1 }, name: 'flowId_1', unique: true }];
  const database = databaseWith({ backups: [], indexes: { [BACKUP]: structuredClone(existing) } });

  await new FlowStore(database, BACKUP).ensureBackupIndex();

  assert.deepEqual(database.state.indexes[BACKUP], existing);
});

test('FlowStore.ensureBackupIndex aborts on a non-unique flowId index', async () => {
  const database = databaseWith({ backups: [], indexes: { [BACKUP]: [{ key: { flowId: 1 }, name: 'flowId_1', unique: false }] } });

  await assert.rejects(new FlowStore(database, BACKUP).ensureBackupIndex(), /non-unique flowId index 'flowId_1'/);
});

test('FlowStore.ensureBackupIndex aborts when existing backups have duplicate flowIds', async () => {
  const duplicates = [{ _id: 'x', flowId: 'f' }, { _id: 'y', flowId: 'f' }];
  const database = databaseWith({ backups: duplicates, indexes: { [BACKUP]: [] } });

  await assert.rejects(new FlowStore(database, BACKUP).ensureBackupIndex(), (error) =>
    error instanceof Aborted && /cannot create a unique flowId index/.test(error.message)
  );
});

test('FlowStore.clearItems clears only while _id, updatedAt and count match', async () => {
  const database = databaseWith();
  const stale = flowDocument({ updatedAt: '2026-10-11T00:00:00.000Z' });

  const cleared = await new FlowStore(database, BACKUP).clearItems(stale);

  assert.deepEqual([cleared, legacyItems(database).length], [false, 3]);
});

// --- phases.js: checkAndExport ----------------------------------------------------------------

test('checkAndExport prints the state lines run.sh reads', async () => {
  const printed = [];
  const exportFile = exportPath();

  await checkAndExport(deps(databaseWith(), printed), { flowId: FLOW_ID, exportFile });

  assert.deepEqual(printed, [
    'WB_STATE ITEM_COUNT=3',
    `WB_STATE V3_ENTRY_COUNT=${V3_ENTRY_COUNT}`,
    'WB_STATE DOCUMENT_ID="doc-1"',
    `WB_STATE EXPORT_FILE=${exportFile}`,
  ]);
});

test('checkAndExport does not write to the database', async () => {
  const database = databaseWith();
  const before = JSON.stringify(database.state);

  await exportedFile(database);

  assert.equal(JSON.stringify(database.state), before);
});

test('checkAndExport with a different existing backup aborts before exporting', async () => {
  const database = databaseWith({ backups: [{ _id: 'old', flowId: FLOW_ID, items: [{ id: 'other' }] }] });
  const exportFile = exportPath();

  await assert.rejects(checkAndExport(deps(database), { flowId: FLOW_ID, exportFile }), /already holds a different backup/);
  assert.equal(fs.existsSync(exportFile), false);
});

test('checkAndExport with a matching backup from an interrupted run notes it will be reused', async () => {
  const printed = [];
  const database = databaseWith({ backups: [{ _id: 'old', flowId: FLOW_ID, items: structuredClone(ORIGINAL_ITEMS) }] });

  await checkAndExport(deps(database, printed), { flowId: FLOW_ID, exportFile: exportPath() });

  assert.match(printed[0], /^note: flowitems_cleanup already holds a backup of exactly these items/);
});

// --- phases.js: apply -------------------------------------------------------------------------

test('apply clears flow.items', async () => {
  const database = databaseWith();
  const exportFile = await exportedFile(database);

  await apply(deps(database), { flowId: FLOW_ID, exportFile });

  assert.deepEqual(legacyItems(database), []);
});

test('apply backs up flowId and exactly the exported items', async () => {
  const database = databaseWith();
  const exportFile = await exportedFile(database);

  await apply(deps(database), { flowId: FLOW_ID, exportFile });

  assert.deepEqual(database.state.collections[BACKUP], [{ _id: 'backup-1', flowId: FLOW_ID, items: ORIGINAL_ITEMS }]);
});

test('apply when an item changed after the export aborts without writing', async () => {
  const database = databaseWith();
  const exportFile = await exportedFile(database);
  legacyItems(database)[1] = { id: 'edited-after-export' };

  await assert.rejects(apply(deps(database), { flowId: FLOW_ID, exportFile }), /changed since it was exported/);
  assert.equal(database.state.collections[BACKUP], undefined);
});

test('apply with a short backup removes it and keeps the items', async () => {
  const database = databaseWith({ faults: { shortBackup: true } });
  const exportFile = await exportedFile(database);

  await assert.rejects(apply(deps(database), { flowId: FLOW_ID, exportFile }), /backup holds 2 items, expected 3/);
  assert.deepEqual([database.state.collections[BACKUP], legacyItems(database).length], [[], 3]);
});

test('apply when an item is edited during the backup keeps the edit and removes the backup', async () => {
  const database = databaseWith({ faults: { editItemDuringBackup: true } });
  const exportFile = await exportedFile(database);

  await assert.rejects(apply(deps(database), { flowId: FLOW_ID, exportFile }), /changed after it was read/);
  assert.deepEqual([legacyItems(database)[0], database.state.collections[BACKUP]], [{ id: 'edited' }, []]);
});

test('apply reuses a matching backup left by an interrupted run and clears', async () => {
  const database = databaseWith();
  const exportFile = await exportedFile(database);
  database.state.collections[BACKUP] = [{ _id: 'left-over', flowId: FLOW_ID, items: structuredClone(ORIGINAL_ITEMS) }];
  const printed = [];

  await apply(deps(database, printed), { flowId: FLOW_ID, exportFile });

  assert.deepEqual(
    [legacyItems(database), database.state.collections[BACKUP].length, printed[0].endsWith('(backup in flowitems_cleanup, reused)')],
    [[], 1, true]
  );
});

test('apply that fails to clear with a reused backup keeps that backup', async () => {
  const database = databaseWith();
  const exportFile = await exportedFile(database);
  database.state.collections[BACKUP] = [{ _id: 'left-over', flowId: FLOW_ID, items: structuredClone(ORIGINAL_ITEMS) }];
  const store = new FlowStore(database, BACKUP);
  store.clearItems = async () => false;

  await assert.rejects(apply({ ...deps(database), store }, { flowId: FLOW_ID, exportFile }), /changed after it was read/);
  assert.equal(database.state.collections[BACKUP].length, 1);
});

test('apply works when the document has no updatedAt', async () => {
  const { updatedAt, ...withoutUpdatedAt } = flowDocument();
  const database = databaseWith({ documents: [withoutUpdatedAt] });
  const exportFile = await exportedFile(database);

  await apply(deps(database), { flowId: FLOW_ID, exportFile });

  assert.deepEqual(legacyItems(database), []);
});

test('apply counts v3 entries only up to the first one', async () => {
  const database = databaseWith();
  const exportFile = await exportedFile(database);
  const store = new FlowStore(database, BACKUP);
  const limits = [];
  const countV3Entries = store.countV3Entries.bind(store);
  store.countV3Entries = (flowId, options) => (limits.push(options), countV3Entries(flowId, options));

  await apply({ ...deps(database), store }, { flowId: FLOW_ID, exportFile });

  assert.deepEqual(limits, [{ limit: 1 }]);
});

// --- main.js ----------------------------------------------------------------------------------

async function runMain(database, env) {
  const printed = [];
  const connection = new FakeMongo(database);
  const code = await main({ connection, env, fs, EJSON: FAKE_EJSON, print: (line) => printed.push(line) });
  return { code, printed, connection };
}

test('main runs check-export on the effective database and returns EXIT_OK', async () => {
  const { code, connection } = await runMain(databaseWith(), environment({ WB_CLEANUP_EXPORT_FILE: exportPath() }));

  assert.deepEqual([code, connection.requestedDatabases], [EXIT_OK, ['brightclass_whiteboard']]);
});

test('main returns EXIT_ABORTED and the reason for an ineligible flow', async () => {
  const database = databaseWith({ documents: [flowDocument({ version: 1 })] });

  const { code, printed } = await runMain(database, environment({ WB_CLEANUP_EXPORT_FILE: exportPath() }));

  assert.deepEqual([code, printed], [EXIT_ABORTED, [`aborted: flow ${FLOW_ID} has version 1, expected 3`]]);
});

test('main returns EXIT_ERROR for invalid settings', async () => {
  const { code } = await runMain(databaseWith(), environment({ WB_CLEANUP_BACKUP_COLLECTION: 'flowitems' }));

  assert.equal(code, EXIT_ERROR);
});

test('main on a database error during apply says a re-run reuses the backup', async () => {
  const database = databaseWith({ faults: { failAfterBackup: true } });
  const exportFile = await exportedFile(database);

  const { code, printed } = await runMain(database, environment({ WB_CLEANUP_PHASE: 'apply', WB_CLEANUP_EXPORT_FILE: exportFile }));

  assert.deepEqual(
    [code, /re-running reuses the matching backup in flowitems_cleanup/.test(printed[0])],
    [EXIT_ERROR, true]
  );
});
