'use strict';
/**
 * Tests for run.sh: its helper functions (sourced into bash), then whole runs end to end.
 *
 * End-to-end tests copy only the script folder to a temporary place (proving it is standalone)
 * and put fake timeout / sleep / redis-cli first on PATH. The fake redis-cli answers from a
 * "first second" pair per counter, switching to the second value after the second TIME call.
 * Run: node --test
 */

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const SCRIPT_DIR = path.resolve(__dirname, '..');
const RUN_SH = path.join(SCRIPT_DIR, 'run.sh');
const SCRIPT_FILES = ['run.sh', '.env.example', 'README.md'];
const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_ERROR = 2;

const QUEUE = 'bull:whiteboard-update-queue';
const FIRST_TIME_REPLY = '1791868232\n123456\n';
const SECOND_TIME_REPLY = '1791868352\n123456\n';
const FIRST_TIME_MS = '1791868232123';
const DEPLOYED_AT = '2026-10-13T05:10:32Z';
const DEPLOYED_MS = '1791868232000';
const READ_ONLY_COMMANDS = ['PING', 'TIME', 'EXISTS', 'ZCARD', 'ZCOUNT', 'LLEN', 'GET', 'HLEN', 'DBSIZE', 'INFO', 'CONFIG'];

// A healthy queue after the fix: completed shrinking (cleanup running), saves flowing.
const HEALTHY_COUNTERS = {
  FAKE_COMPLETED: '9960000 9959000',
  FAKE_FAILED: '12 12',
  FAKE_WAIT: '0 0',
  FAKE_ACTIVE: '0 1',
  FAKE_DELAYED: '1 1',
  FAKE_PRIORITIZED: '0 0',
  FAKE_PAUSED: '0 0',
  FAKE_ID: '5000 5250',
  FAKE_REPEAT: '1 1',
  FAKE_FLOWMAP: '40 3',
};

// --- helpers ----------------------------------------------------------------------------------

/** Quote a value for bash with single quotes. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Source run.sh (main does not run when sourced) and run `script` in bash. */
function runBash(script, { env = {}, input } = {}) {
  return spawnSync('bash', ['-c', `source ${shellQuote(RUN_SH)}; ${script}`], {
    encoding: 'utf8',
    input,
    env: { PATH: process.env.PATH, ...env },
  });
}

/** Write an executable bash script. */
function writeExecutable(filePath, body) {
  fs.writeFileSync(filePath, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(filePath, 0o755);
}

/** Every file path under ROOT, relative and sorted. */
function listFiles(root) {
  return fs.readdirSync(root, { recursive: true })
    .filter((name) => fs.statSync(path.join(root, name)).isFile())
    .sort();
}

/** A copy of the script folder and fake commands on PATH. */
class ScriptRun {
  constructor() {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'whiteboard-queue-check-'));
    this.copyDir = path.join(this.root, 'copied-script');
    this.workDir = path.join(this.root, 'work');
    this.binDir = path.join(this.root, 'bin');
    this.callsFile = path.join(this.root, 'calls.txt');
    this.sampleFile = path.join(this.root, 'sample.txt');
    for (const directory of [this.copyDir, this.workDir, this.binDir]) fs.mkdirSync(directory);
    for (const name of SCRIPT_FILES) fs.cpSync(path.join(SCRIPT_DIR, name), path.join(this.copyDir, name));
    fs.writeFileSync(this.callsFile, '');
    fs.writeFileSync(this.sampleFile, '0');
    this.writeFakeCommands();
  }

  writeFakeCommands() {
    const bin = (name, body) => writeExecutable(path.join(this.binDir, name), body);
    const record = (name) => `printf '%s %s\\n' ${name} "$*" >> ${shellQuote(this.callsFile)}`;
    bin('timeout', [
      '[[ "$1" == -k ]] && shift 2',
      'limit="$1"; shift',
      'exec perl -e \'alarm shift; exec @ARGV or die "exec: $!"\' "$limit" "$@"',
    ].join('\n'));
    bin('sleep', record('sleep'));
    bin('hostname', 'echo BrightClass-Production');
    bin('redis-cli', [
      record('redis-cli'),
      'shift 6',
      `sample="$(cat ${shellQuote(this.sampleFile)})"`,
      // pick "FIRST SECOND" — print the value for the current sample.
      'pick() { set -- $1; if [[ "$sample" -le 1 ]]; then echo "$1"; else echo "${2:-$1}"; fi; }',
      'case "$1" in',
      '  PING) [[ -n "${FAKE_PING_ERROR:-}" ]] && { echo "$FAKE_PING_ERROR" >&2; exit 1; }; echo PONG ;;',
      '  EXISTS) echo "${FAKE_META_EXISTS:-1}" ;;',
      '  TIME)',
      '    sample=$((sample + 1)); echo "$sample" > ' + shellQuote(this.sampleFile),
      `    if [[ "$sample" -eq 1 ]]; then printf ${shellQuote(FIRST_TIME_REPLY)}; else printf ${shellQuote(SECOND_TIME_REPLY)}; fi ;;`,
      '  ZCARD|LLEN|GET|HLEN)',
      '    case "$2" in',
      `      ${QUEUE}:completed) pick "$FAKE_COMPLETED" ;;`,
      `      ${QUEUE}:failed) pick "$FAKE_FAILED" ;;`,
      `      ${QUEUE}:wait) pick "$FAKE_WAIT" ;;`,
      `      ${QUEUE}:active) pick "$FAKE_ACTIVE" ;;`,
      `      ${QUEUE}:delayed) pick "$FAKE_DELAYED" ;;`,
      `      ${QUEUE}:prioritized) pick "$FAKE_PRIORITIZED" ;;`,
      `      ${QUEUE}:paused) pick "$FAKE_PAUSED" ;;`,
      `      ${QUEUE}:id) pick "$FAKE_ID" ;;`,
      `      ${QUEUE}:repeat) pick "$FAKE_REPEAT" ;;`,
      '      whiteboard:flowMap) pick "$FAKE_FLOWMAP" ;;',
      '    esac ;;',
      `  ZCOUNT) if [[ "$3" == "(${FIRST_TIME_MS}" ]]; then echo "\${FAKE_KEPT_IN_WINDOW:-0}"; else echo "\${FAKE_KEPT_SINCE_DEPLOY:-0}"; fi ;;`,
      '  DBSIZE) echo 9960500 ;;',
      '  INFO) printf "# Memory\\r\\nused_memory_human:3.90G\\r\\nmaxmemory_human:0B\\r\\n" ;;',
      '  CONFIG) printf "maxmemory-policy\\n%s\\n" "${FAKE_POLICY-noeviction}" ;;',
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'));
  }

  writeEnvFile(content) {
    fs.writeFileSync(path.join(this.copyDir, '.env'), content);
  }

  run(args = [], env = {}) {
    return spawnSync('bash', [path.join(this.copyDir, 'run.sh'), ...args], {
      cwd: this.workDir,
      encoding: 'utf8',
      env: { PATH: `${this.binDir}:${process.env.PATH}`, ...HEALTHY_COUNTERS, ...env },
    });
  }

  calls(command) {
    return fs.readFileSync(this.callsFile, 'utf8').trim().split('\n')
      .filter((line) => line.startsWith(`${command} `))
      .map((line) => line.slice(command.length + 1));
  }
}

// --- helpers: settings ------------------------------------------------------------------------

test('simple_name rejects shell metacharacters', () => {
  const result = runBash("simple_name WB_QUEUE_CHECK_REDIS_HOST 'localhost;reboot'");

  assert.match(result.stderr, /WB_QUEUE_CHECK_REDIS_HOST must be a plain name/);
});

test('redis_db_number above 15 exits with the configuration error code', () => {
  const result = runBash('redis_db_number WB_QUEUE_CHECK_REDIS_DB 16');

  assert.equal(result.status, EXIT_ERROR);
});

test('redis_db_number accepts database 0', () => {
  const result = runBash('redis_db_number WB_QUEUE_CHECK_REDIS_DB 0');

  assert.equal(result.stdout, '0');
});

test('positive_integer with 0 exits with the configuration error code', () => {
  const result = runBash('positive_integer WB_QUEUE_CHECK_SAMPLE_SECONDS 0');

  assert.equal(result.status, EXIT_ERROR);
});

test('load_env_file ignores keys without the WB_QUEUE_CHECK_ prefix', () => {
  const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-env-')), '.env');
  fs.writeFileSync(envFile, 'PATH=/nowhere\nWB_QUEUE_CHECK_REDIS_DB=3\n');

  const result = runBash(`load_env_file ${shellQuote(envFile)}; printf '%s' "$WB_QUEUE_CHECK_REDIS_DB"`);

  assert.equal(result.stdout, '3');
});

test('iso_to_epoch converts a UTC time to epoch seconds', () => {
  const result = runBash(`iso_to_epoch ${DEPLOYED_AT}`);

  assert.equal(result.stdout, '1791868232');
});

// --- helpers: parsing replies -----------------------------------------------------------------

test('count_reply passes a whole number through', () => {
  const result = runBash("count_reply 'ZCARD x' 9960000");

  assert.equal(result.stdout, '9960000');
});

test('count_reply with an auth error reply names REDISCLI_AUTH', () => {
  const result = runBash("count_reply 'ZCARD x' 'NOAUTH Authentication required.'");

  assert.match(result.stderr, /export REDISCLI_AUTH/);
});

test('time_reply_to_ms joins seconds and microseconds into exact milliseconds', () => {
  const result = runBash('time_reply_to_ms', { input: FIRST_TIME_REPLY });

  assert.equal(result.stdout, FIRST_TIME_MS);
});

test('time_reply_to_ms with an error reply exits with the configuration error code', () => {
  const result = runBash('time_reply_to_ms', { input: 'NOAUTH Authentication required.\n' });

  assert.equal(result.status, EXIT_ERROR);
});

// --- helpers: checks --------------------------------------------------------------------------

test('check_completed_in_window with kept jobs fails', () => {
  const result = runBash('check_completed_in_window 3 250 120');

  assert.match(result.stdout, /^FAIL {2}3 job\(s\) finished in the 120 s window and were kept/);
});

test('check_completed_in_window with none kept while saves were queued passes', () => {
  const result = runBash('check_completed_in_window 0 250 120');

  assert.match(result.stdout, /^PASS/);
});

test('check_completed_in_window with no saves in a window shorter than the batch interval warns', () => {
  const result = runBash('check_completed_in_window 0 0 30');

  assert.match(result.stdout, /^WARN.*inconclusive/);
});

test('check_completed_in_window with no saves but a full batch interval passes', () => {
  const result = runBash('check_completed_in_window 0 0 60');

  assert.match(result.stdout, /^PASS/);
});

test('check_kept_since_deploy with kept jobs fails', () => {
  const result = runBash(`check_kept_since_deploy 1 ${DEPLOYED_AT}`);

  assert.match(result.stdout, /^FAIL/);
});

test('check_batch_updater_scheduled with no repeat registration fails', () => {
  const result = runBash('check_batch_updater_scheduled 0');

  assert.match(result.stdout, /^FAIL.*not scheduled/);
});

test('check_worker_processing with waiting above the limit fails', () => {
  const result = runBash('check_worker_processing 10 900 1001 1000');

  assert.match(result.stdout, /^FAIL.*not keeping up/);
});

test('check_worker_processing when every queued save is still waiting fails', () => {
  const result = runBash('check_worker_processing 250 0 250 1000');

  assert.match(result.stdout, /^FAIL.*is the worker running/);
});

test('check_worker_processing with waiting exactly at the limit passes', () => {
  const result = runBash('check_worker_processing 0 1000 1000 1000');

  assert.match(result.stdout, /^PASS/);
});

test('check_failed_growth with new failed jobs warns', () => {
  const result = runBash('check_failed_growth 12 15');

  assert.match(result.stdout, /^WARN {2}3 job\(s\) failed/);
});

test('check_eviction_policy with allkeys-lru warns', () => {
  const result = runBash('check_eviction_policy allkeys-lru');

  assert.match(result.stdout, /^WARN.*needs noeviction/);
});

test('check_eviction_policy with an unreadable policy warns', () => {
  const result = runBash("check_eviction_policy ''");

  assert.match(result.stdout, /^WARN.*could not read/);
});

// --- end to end: verdicts ---------------------------------------------------------------------

test('a run on a healthy queue exits 0', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.equal(result.status, EXIT_PASS, result.stderr);
});

test('a run on a healthy queue reports PASS with no warnings', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, /RESULT: PASS \(0 warning\(s\)\)/);
});

test('a run where jobs finished in the window were kept exits 1', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run([], { FAKE_KEPT_IN_WINDOW: '250' });

  assert.equal(result.status, EXIT_FAIL);
});

test('a run counts kept jobs from the first sample time, exclusive', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run();

  assert.ok(scriptRun.calls('redis-cli').some((call) => call.endsWith(`ZCOUNT ${QUEUE}:completed (${FIRST_TIME_MS} +inf`)));
});

test('a run with --deployed-at counts kept jobs from the deploy time', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--deployed-at', DEPLOYED_AT]);

  assert.ok(scriptRun.calls('redis-cli').some((call) => call.endsWith(`ZCOUNT ${QUEUE}:completed ${DEPLOYED_MS} +inf`)));
});

test('a run with jobs kept since the deploy exits 1', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--deployed-at', DEPLOYED_AT], { FAKE_KEPT_SINCE_DEPLOY: '7' });

  assert.equal(result.status, EXIT_FAIL);
});

test('a run without a deploy time does not count jobs since a deploy', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run();

  assert.equal(scriptRun.calls('redis-cli').filter((call) => call.includes(' ZCOUNT ')).length, 1);
});

test('a run with no batch updater registered exits 1', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run([], { FAKE_REPEAT: '0 0' });

  assert.equal(result.status, EXIT_FAIL);
});

test('a run where the worker processed nothing exits 1', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run([], { FAKE_WAIT: '0 250' });

  assert.equal(result.status, EXIT_FAIL);
});

test('a run with new failed jobs still exits 0', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run([], { FAKE_FAILED: '12 20' });

  assert.equal(result.status, EXIT_PASS);
});

test('a run with an evicting policy reports one warning', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run([], { FAKE_POLICY: 'allkeys-lru' });

  assert.match(result.stdout, /RESULT: PASS \(1 warning\(s\)\)/);
});

test('a run shows the change in completed jobs between the samples', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, /completed \(should not grow\) +9960000 +9959000 +-1000\n/);
});

test('a run reports the window from Redis server time', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, /two samples 120 s apart/);
});

// --- end to end: settings ---------------------------------------------------------------------

test('a run without a .env connects to 127.0.0.1:6379 database 0', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run();

  assert.equal(scriptRun.calls('redis-cli')[0], '-h 127.0.0.1 -p 6379 -n 0 PING');
});

test('a run reads the .env next to the script', () => {
  const scriptRun = new ScriptRun();
  scriptRun.writeEnvFile('WB_QUEUE_CHECK_REDIS_HOST=10.0.0.5\nWB_QUEUE_CHECK_REDIS_PORT="6380"\nWB_QUEUE_CHECK_REDIS_DB=2 # queue db\n');

  scriptRun.run();

  assert.equal(scriptRun.calls('redis-cli')[0], '-h 10.0.0.5 -p 6380 -n 2 PING');
});

test('a run with --env-file reads that file instead', () => {
  const scriptRun = new ScriptRun();
  const otherEnv = path.join(scriptRun.root, 'other.env');
  fs.writeFileSync(otherEnv, 'WB_QUEUE_CHECK_REDIS_PORT=6390\n');

  scriptRun.run(['--env-file', otherEnv]);

  assert.equal(scriptRun.calls('redis-cli')[0], '-h 127.0.0.1 -p 6390 -n 0 PING');
});

test('a run lets an exported variable win over the .env', () => {
  const scriptRun = new ScriptRun();
  scriptRun.writeEnvFile('WB_QUEUE_CHECK_REDIS_PORT=6380\n');

  scriptRun.run([], { WB_QUEUE_CHECK_REDIS_PORT: '6381' });

  assert.equal(scriptRun.calls('redis-cli')[0], '-h 127.0.0.1 -p 6381 -n 0 PING');
});

test('a run takes the deploy time from the .env', () => {
  const scriptRun = new ScriptRun();
  scriptRun.writeEnvFile(`WB_QUEUE_CHECK_DEPLOYED_AT=${DEPLOYED_AT}\n`);

  const result = scriptRun.run();

  assert.match(result.stdout, /deployed at: 2026-10-13T05:10:32Z/);
});

test('a run waits the default 120 s between samples', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run();

  assert.deepEqual(scriptRun.calls('sleep'), ['120']);
});

test('a run waits WB_QUEUE_CHECK_SAMPLE_SECONDS between samples', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run([], { WB_QUEUE_CHECK_SAMPLE_SECONDS: '60' });

  assert.deepEqual(scriptRun.calls('sleep'), ['60']);
});

// --- end to end: safety and errors ------------------------------------------------------------

test('a run only ever calls read-only redis-cli commands', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--deployed-at', DEPLOYED_AT]);

  const commands = new Set(scriptRun.calls('redis-cli').map((call) => call.split(' ')[6]));
  assert.ok([...commands].every((command) => READ_ONLY_COMMANDS.includes(command)), [...commands].join(', '));
});

test('a run calls CONFIG only as CONFIG GET', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run();

  const configCalls = scriptRun.calls('redis-cli').filter((call) => call.split(' ')[6] === 'CONFIG');
  assert.deepEqual(configCalls, ['-h 127.0.0.1 -p 6379 -n 0 CONFIG GET maxmemory-policy']);
});

test('a run saves the report to one log file under ./logs of the working directory', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run();

  assert.deepEqual(listFiles(scriptRun.workDir).map((name) => name.replace(/\d{8}T\d{6}Z/, 'TIMESTAMP')), [
    path.join('logs', 'whiteboard-queue-TIMESTAMP.log'),
  ]);
});

test('a run when Redis does not answer exits with the configuration error code', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run([], { FAKE_PING_ERROR: 'Could not connect to Redis at 127.0.0.1:6379: Connection refused' });

  assert.equal(result.status, EXIT_ERROR);
});

test('a run when Redis does not answer writes no log', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run([], { FAKE_PING_ERROR: 'Could not connect to Redis at 127.0.0.1:6379: Connection refused' });

  assert.deepEqual(listFiles(scriptRun.workDir), []);
});

test('a run against a database without the queue names the wrong database', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run([], { FAKE_META_EXISTS: '0' });

  assert.match(result.stderr, /meta not found in db 0: wrong database/);
});

test('a run against a database without the queue writes no log', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run([], { FAKE_META_EXISTS: '0' });

  assert.deepEqual(listFiles(scriptRun.workDir), []);
});

test('a run when a counter read returns an error exits with the configuration error code', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run([], { FAKE_COMPLETED: 'NOAUTH NOAUTH' });

  assert.equal(result.status, EXIT_ERROR);
});

test('a run with a missing --env-file exits with the configuration error code', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--env-file', '/nowhere/.env']);

  assert.equal(result.status, EXIT_ERROR);
});

test('a run with a malformed --deployed-at writes no log', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--deployed-at', 'yesterday']);

  assert.deepEqual(listFiles(scriptRun.workDir), []);
});

test('a run with an unknown argument exits with the configuration error code', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--flushall']);

  assert.equal(result.status, EXIT_ERROR);
});

test('--help prints the usage and exits 0', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--help']);

  assert.match(result.stdout, /READ-ONLY on Redis/);
});
