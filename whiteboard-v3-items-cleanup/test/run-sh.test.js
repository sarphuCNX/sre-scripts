'use strict';
/**
 * Tests for run.sh: its helper functions (sourced into bash), then whole runs end to end.
 *
 * End-to-end tests copy only the script folder to a temporary place (proving it is standalone)
 * and replace mongosh with fakes/fake-mongosh.js, an in-memory fake. Run: node --test
 */

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const SCRIPT_DIR = path.resolve(__dirname, '..');
const RUN_SH = path.join(SCRIPT_DIR, 'run.sh');
const SCRIPT_FILES = ['run.sh', 'cleanup.js', 'lib', '.env.example', 'README.md'];
const FAKE_MONGOSH_JS = path.join(__dirname, 'fakes', 'fake-mongosh.js');

const FLOW_ID = '3853af3f-761e-412d-b84a-dbc26eddeffe';
const UPDATED_AT = '2026-10-12T04:00:00.000Z';
const SECRET_URI = 'mongodb://wb_admin:s3cret@localhost:27017/brightclass_whiteboard';
const CONFIRMED = `${FLOW_ID}\n${FLOW_ID}\n`;
const EXIT_CLEARED = 0;
const EXIT_ABORTED = 1;
const EXIT_ERROR = 2;

// --- helpers ----------------------------------------------------------------------------------

/** Quote a value for bash with single quotes. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Source run.sh (main does not run when sourced) and run `script` in bash. */
function runBash(script) {
  return spawnSync('bash', ['-c', `source ${shellQuote(RUN_SH)}; ${script}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
}

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cleanup-run-sh-'));
}

function writeEnv(directory, content) {
  const envFile = path.join(directory, '.env');
  fs.writeFileSync(envFile, content);
  return envFile;
}

function flowDocument(overrides = {}) {
  return {
    _id: 'doc-1',
    flowId: FLOW_ID,
    version: 3,
    updatedAt: UPDATED_AT,
    flow: { migratedAt: '2026-06-01T10:00:00.000Z', items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    ...overrides,
  };
}

/** A copy of the script folder in a temp dir, a fake mongosh, and its JSON database. */
class ScriptRun {
  constructor({ documents = [flowDocument()], faults = {} } = {}) {
    const root = temporaryDirectory();
    this.root = root;
    this.copyDir = path.join(root, 'copied-script');
    fs.mkdirSync(this.copyDir);
    for (const name of SCRIPT_FILES) {
      fs.cpSync(path.join(SCRIPT_DIR, name), path.join(this.copyDir, name), { recursive: true });
    }
    this.stateFile = path.join(root, 'fake-db.json');
    this.callsFile = path.join(root, 'mongosh-calls.ndjson');
    this.backupDir = path.join(root, 'exports');
    this.fakeMongosh = path.join(root, 'mongosh');
    fs.writeFileSync(this.callsFile, '');
    fs.writeFileSync(
      this.stateFile,
      JSON.stringify({
        collections: { flowitems: documents, flowitementryv3: [{ flowId: FLOW_ID, elementId: 'e1' }] },
        faults,
      })
    );
    fs.writeFileSync(this.fakeMongosh, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_MONGOSH_JS}" "$@"\n`);
    fs.chmodSync(this.fakeMongosh, 0o755);
  }

  run(stdin, args = [], env = {}) {
    return spawnSync('bash', [path.join(this.copyDir, 'run.sh'), ...args], {
      input: stdin,
      encoding: 'utf8',
      cwd: this.copyDir,
      env: {
        PATH: process.env.PATH,
        MONGOSH: this.fakeMongosh,
        FAKE_MONGO_STATE: this.stateFile,
        FAKE_MONGO_CALLS: this.callsFile,
        WB_CLEANUP_MONGO_URI: SECRET_URI,
        WB_CLEANUP_BACKUP_DIR: this.backupDir,
        ...env,
      },
    });
  }

  get state() {
    return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
  }

  /** One {args, uri} record per mongosh call: its argv and its WB_CLEANUP_MONGO_URI. */
  get mongoshCalls() {
    return fs.readFileSync(this.callsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  clearFaults() {
    fs.writeFileSync(this.stateFile, JSON.stringify({ ...this.state, faults: {} }));
  }

  items() {
    return this.state.collections.flowitems[0].flow.items;
  }

  exports() {
    return fs.existsSync(this.backupDir) ? fs.readdirSync(this.backupDir).filter((name) => name.endsWith('.json')).sort() : [];
  }
}

// --- unquote ----------------------------------------------------------------------------------

for (const [raw, expected] of [
  ['plain', 'plain'],
  ['"double quoted"', 'double quoted'],
  ["'single quoted'", 'single quoted'],
  ['"db#1"', 'db#1'],
  ['value  # trailing comment', 'value'],
  ['a # first # second', 'a'],
  ['mongodb://h:1/db?authSource=admin&directConnection=true', 'mongodb://h:1/db?authSource=admin&directConnection=true'],
  ['# only a comment', ''],
  ['', ''],
]) {
  test(`unquote reads ${JSON.stringify(raw)} like a .env file`, () => {
    const result = runBash(`unquote ${shellQuote(raw)}`);

    assert.equal(result.stdout, expected);
  });
}

// --- load_env_file ----------------------------------------------------------------------------

for (const [content, expected] of [
  ['WB_CLEANUP_DATABASE=plain\n', 'plain'],
  ['# comment\n\n   \n# WB_CLEANUP_DATABASE=commented\nWB_CLEANUP_DATABASE=real\n', 'real'],
  ['export WB_CLEANUP_DATABASE=exported\n', 'exported'],
  ['  WB_CLEANUP_DATABASE =  spaced  \n', 'spaced'],
  ['WB_CLEANUP_DATABASE=no_trailing_newline', 'no_trailing_newline'],
  ['WB_CLEANUP_DATABASE=crlf\r\n', 'crlf'],
  ['WB_CLEANUP_DATABASE="quoted value"\n', 'quoted value'],
]) {
  test(`load_env_file reads ${JSON.stringify(content)}`, () => {
    const envFile = writeEnv(temporaryDirectory(), content);

    const result = runBash(`load_env_file ${shellQuote(envFile)}; printf %s "$WB_CLEANUP_DATABASE"`);

    assert.equal(result.stdout, expected);
  });
}

test('load_env_file keeps a value already exported in the shell', () => {
  const envFile = writeEnv(temporaryDirectory(), 'WB_CLEANUP_DATABASE=from_file\n');

  const result = runBash(
    `export WB_CLEANUP_DATABASE=from_shell; load_env_file ${shellQuote(envFile)}; printf %s "$WB_CLEANUP_DATABASE"`
  );

  assert.equal(result.stdout, 'from_shell');
});

test('load_env_file ignores keys outside WB_CLEANUP_*', () => {
  const envFile = writeEnv(temporaryDirectory(), 'PATH=/nowhere\nOTHER_SETTING=x\n');

  const result = runBash(`load_env_file ${shellQuote(envFile)}; printf %s "\${OTHER_SETTING:-unset}"`);

  assert.equal(result.stdout, 'unset');
});

test('load_env_file never executes the file', () => {
  const directory = temporaryDirectory();
  const marker = path.join(directory, 'executed');
  const envFile = writeEnv(directory, `WB_CLEANUP_DATABASE=$(touch ${marker})\n`);

  runBash(`load_env_file ${shellQuote(envFile)}`);

  assert.equal(fs.existsSync(marker), false);
});

// --- redact_uri / uri_database ----------------------------------------------------------------

for (const [uri, expected] of [
  ['mongodb://localhost:27017/brightclass_whiteboard', 'localhost:27017/brightclass_whiteboard'],
  [`${SECRET_URI}?authSource=admin`, 'localhost:27017/brightclass_whiteboard'],
  ['mongodb+srv://wb_admin:s3cret@cluster0.example.net/', 'cluster0.example.net/'],
]) {
  test(`redact_uri drops scheme, credentials and query from ${uri}`, () => {
    const result = runBash(`redact_uri ${shellQuote(uri)}`);

    assert.equal(result.stdout, expected);
  });
}

for (const [uri, expected] of [
  ['mongodb://localhost:27017/brightclass_whiteboard?directConnection=true', 'brightclass_whiteboard'],
  ['mongodb://localhost:27017/', ''],
  ['mongodb://localhost:27017', ''],
  ['mongodb://localhost:27017/?directConnection=true', ''],
]) {
  test(`uri_database reads ${JSON.stringify(expected)} from ${uri}`, () => {
    const result = runBash(`uri_database ${shellQuote(uri)}`);

    assert.equal(result.stdout, expected);
  });
}

// --- valid_flow_id / check_backup_collection / free_export_path -------------------------------

for (const flowId of ['../etc/passwd', 'flow id', '{"$ne":null}', '']) {
  test(`valid_flow_id rejects ${JSON.stringify(flowId)}`, () => {
    const result = runBash(`valid_flow_id ${shellQuote(flowId)}`);

    assert.notEqual(result.status, 0);
  });
}

test('valid_flow_id accepts a UUID', () => {
  const result = runBash(`valid_flow_id ${FLOW_ID}`);

  assert.equal(result.status, 0);
});

for (const name of ['flowitems', 'flowitementryv3', 'system.profile', 'flow$items']) {
  test(`check_backup_collection refuses ${name}`, () => {
    const result = runBash(`check_backup_collection ${shellQuote(name)}`);

    assert.equal(result.status, EXIT_ERROR);
  });
}

test('free_export_path without a collision uses the plain name', () => {
  const directory = temporaryDirectory();
  const stamp = '20261012T053007Z';

  const result = runBash(`free_export_path ${shellQuote(directory)} ${FLOW_ID} ${stamp}`);

  assert.equal(result.stdout, `${directory}/${FLOW_ID}-${stamp}.json`);
});

test('free_export_path with existing exports appends the next suffix', () => {
  const directory = temporaryDirectory();
  const stamp = '20261012T053007Z';
  fs.writeFileSync(path.join(directory, `${FLOW_ID}-${stamp}.json`), '{}');
  fs.writeFileSync(path.join(directory, `${FLOW_ID}-${stamp}-1.json`), '{}');

  const result = runBash(`free_export_path ${shellQuote(directory)} ${FLOW_ID} ${stamp}`);

  assert.equal(result.stdout, `${directory}/${FLOW_ID}-${stamp}-2.json`);
});

// --- end to end -------------------------------------------------------------------------------

test('a confirmed run exits with the cleared code', () => {
  const run = new ScriptRun();

  const result = run.run(CONFIRMED);

  assert.equal(result.status, EXIT_CLEARED, result.stdout + result.stderr);
});

test('a confirmed run clears flow.items', () => {
  const run = new ScriptRun();

  run.run(CONFIRMED);

  assert.deepEqual(run.items(), []);
});

test('a confirmed run backs up the original items', () => {
  const run = new ScriptRun();

  run.run(CONFIRMED);

  assert.deepEqual(run.state.collections.flowitems_cleanup, [
    { _id: 'backup-1', flowId: FLOW_ID, items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
  ]);
});

test('a confirmed run exports the document before clearing it', () => {
  const run = new ScriptRun();

  run.run(CONFIRMED);

  const exported = JSON.parse(fs.readFileSync(path.join(run.backupDir, run.exports()[0]), 'utf8'));
  assert.equal(exported.flow.items.length, 3);
});

test('the export is named by flowId and UTC timestamp', () => {
  const run = new ScriptRun();

  run.run(CONFIRMED);

  assert.match(run.exports()[0], new RegExp(`^${FLOW_ID}-\\d{8}T\\d{6}Z\\.json$`));
});

test('a wrong confirmation aborts and keeps the items', () => {
  const run = new ScriptRun();

  const result = run.run(`${FLOW_ID}\nsomething-else\n`);

  assert.deepEqual([result.status, run.items().length], [EXIT_ABORTED, 3]);
});

test('input ending before the confirmation aborts', () => {
  const run = new ScriptRun();

  const result = run.run(`${FLOW_ID}\n`);

  assert.deepEqual([result.status, run.items().length], [EXIT_ABORTED, 3]);
});

test('a dry run exports without database writes', () => {
  const run = new ScriptRun();

  const result = run.run(`${FLOW_ID}\n`, ['--dry-run']);

  assert.deepEqual(
    [result.status, run.items().length, 'flowitems_cleanup' in run.state.collections, run.exports().length],
    [EXIT_CLEARED, 3, false, 1]
  );
});

test('a dry run calls mongosh once', () => {
  const run = new ScriptRun();

  run.run(`${FLOW_ID}\n`, ['--dry-run']);

  assert.equal(run.mongoshCalls.length, 1);
});

test('mongosh is called with --nodb --quiet --norc and cleanup.js', () => {
  const run = new ScriptRun();

  run.run(`${FLOW_ID}\n`, ['--dry-run']);

  assert.deepEqual(run.mongoshCalls[0].args, ['--nodb', '--quiet', '--norc', '--file', path.join(run.copyDir, 'cleanup.js')]);
});

test('the URI reaches mongosh only through the environment', () => {
  const run = new ScriptRun();

  run.run(CONFIRMED);

  assert.deepEqual(
    run.mongoshCalls.map((call) => [call.args.includes(SECRET_URI), call.uri]),
    [
      [false, SECRET_URI],
      [false, SECRET_URI],
    ]
  );
});

test('a crash between backup and clear exits with the error code and keeps the items', () => {
  const run = new ScriptRun({ faults: { failAfterBackup: true } });

  const result = run.run(CONFIRMED);

  assert.deepEqual([result.status, run.items().length], [EXIT_ERROR, 3]);
});

test('a re-run after a crash reuses the backup and clears', () => {
  const run = new ScriptRun({ faults: { failAfterBackup: true } });
  run.run(CONFIRMED);
  run.clearFaults();

  const result = run.run(CONFIRMED);

  assert.deepEqual([result.status, run.items(), run.state.collections.flowitems_cleanup.length], [EXIT_CLEARED, [], 1]);
});

test('an ineligible flow aborts without an export', () => {
  const run = new ScriptRun({ documents: [flowDocument({ version: 1 })] });

  const result = run.run(CONFIRMED);

  assert.deepEqual([result.status, run.exports()], [EXIT_ABORTED, []]);
});

test('an ineligible flow prints the reason', () => {
  const run = new ScriptRun({ documents: [flowDocument({ version: 1 })] });

  const result = run.run(CONFIRMED);

  assert.match(result.stderr, /has version 1, expected 3/);
});

test('an item edited in place during the backup aborts and keeps the edit', () => {
  const run = new ScriptRun({ faults: { editItemDuringBackup: true } });

  const result = run.run(CONFIRMED);

  assert.deepEqual([result.status, run.items()[0]], [EXIT_ABORTED, { id: 'edited' }]);
});

test('an invalid flowId aborts before calling mongosh', () => {
  const run = new ScriptRun();

  const result = run.run('../etc/passwd\n');

  assert.deepEqual([result.status, run.mongoshCalls], [EXIT_ABORTED, []]);
});

test('a missing WB_CLEANUP_MONGO_URI exits with the error code', () => {
  const run = new ScriptRun();

  const result = run.run(CONFIRMED, [], { WB_CLEANUP_MONGO_URI: '' });

  assert.equal(result.status, EXIT_ERROR);
});

test('a source collection as backup collection exits with the error code before mongosh', () => {
  const run = new ScriptRun();

  const result = run.run(CONFIRMED, [], { WB_CLEANUP_BACKUP_COLLECTION: 'flowitems' });

  assert.deepEqual([result.status, run.mongoshCalls], [EXIT_ERROR, []]);
});

test('a missing mongosh exits with the error code', () => {
  const run = new ScriptRun();

  const result = run.run(CONFIRMED, [], { MONGOSH: path.join(run.root, 'no-such-mongosh') });

  assert.equal(result.status, EXIT_ERROR);
});

test('a failing mongosh exits with the error code and keeps the items', () => {
  const run = new ScriptRun();
  fs.writeFileSync(run.fakeMongosh, "#!/bin/sh\necho 'MongoServerSelectionError' >&2\nexit 1\n");

  const result = run.run(CONFIRMED);

  assert.deepEqual([result.status, run.items().length], [EXIT_ERROR, 3]);
});

test('the .env next to the copied script is read', () => {
  const run = new ScriptRun();
  writeEnv(run.copyDir, 'WB_CLEANUP_BACKUP_COLLECTION=flowitems_cleanup_trial\n');

  run.run(CONFIRMED);

  assert.equal('flowitems_cleanup_trial' in run.state.collections, true);
});

test('a missing --env-file exits with the error code', () => {
  const run = new ScriptRun();

  const result = run.run(CONFIRMED, ['--env-file', path.join(run.root, 'missing.env')]);

  assert.equal(result.status, EXIT_ERROR);
});

test('mongo credentials are never printed', () => {
  const run = new ScriptRun();

  const result = run.run(CONFIRMED);

  assert.equal((result.stdout + result.stderr).includes('s3cret'), false);
});

test('the redacted target is printed', () => {
  const run = new ScriptRun();

  const result = run.run(`${FLOW_ID}\n`, ['--dry-run']);

  assert.match(result.stdout, /target: localhost:27017\/brightclass_whiteboard \(dry run\)/);
});

test('--help prints the usage and succeeds', () => {
  const run = new ScriptRun();

  const result = run.run('', ['--help']);

  assert.deepEqual([result.status, result.stdout.includes('Usage:')], [EXIT_CLEARED, true]);
});
