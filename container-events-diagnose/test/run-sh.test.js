'use strict';
/**
 * Tests for run.sh: its helper functions (sourced into bash), then whole runs end to end.
 *
 * End-to-end tests copy only the script folder to a temporary place (proving it is standalone)
 * and put fake sudo / docker / journalctl / sar / uptime first on PATH. Shell history files are
 * real files read with the real `grep`.
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
const EXIT_OK = 0;
const EXIT_ERROR = 2;
const EXIT_BUSY = 3;

const CONTAINER = 'controller-server';
const CONTAINER_ID = '6f70859c8b89aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SINCE = '2026-10-13T05:00:00Z';
const SINCE_EPOCH = 1791867600;
const STOP_EPOCH = 1791876600; // 2026-10-13T07:30:00Z
const START_EPOCH = 1791877500; // 2026-10-13T07:45:00Z
const NANOSECONDS = '000000000';
const DEFAULT_WINDOW_SECONDS = 6 * 3600;
const WINDOW_TOLERANCE_SECONDS = 30;

const HISTORY = [
  'docker ps',
  'docker stop controller-server',
  'docker restart navneet-controller-server',
  'docker compose up -d controller-server',
  'sudo docker stop controller-server-old',
  'docker stopx controller-server',
].join('\n');

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

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'container-events-diagnose-'));
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

/** A copy of the script folder, a shell history file, and fake commands on PATH. */
class ScriptRun {
  constructor() {
    this.root = temporaryDirectory();
    this.copyDir = path.join(this.root, 'copied-script');
    this.workDir = path.join(this.root, 'work');
    this.binDir = path.join(this.root, 'bin');
    this.historyFile = path.join(this.root, 'bash_history');
    this.callsFile = path.join(this.root, 'calls.txt');
    for (const directory of [this.copyDir, this.workDir, this.binDir]) fs.mkdirSync(directory);
    for (const name of SCRIPT_FILES) {
      fs.cpSync(path.join(SCRIPT_DIR, name), path.join(this.copyDir, name), { recursive: true });
    }
    fs.writeFileSync(this.historyFile, `${HISTORY}\n`);
    fs.writeFileSync(this.callsFile, '');
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
    bin('sudo', [
      record('sudo'),
      '[[ "$1" == -n ]] && shift',
      '[[ "${FAKE_SUDO_DENIED:-0}" == 1 ]] && exit 1',
      'exec "$@"',
    ].join('\n'));
    bin('renice', record('renice'));
    bin('ionice', record('ionice'));
    bin('flock', '[[ "${FAKE_FLOCK_BUSY:-0}" == 1 ]] && exit 1; exit 0');
    bin('hostname', 'echo BrightClass-Production');
    bin('uptime', 'echo " 07:50:00 up 96 days,  load average: 6.10, 9.18, 39.90"');
    bin('docker', [
      record('docker'),
      'case "$1" in',
      '  inspect)',
      '    case "$3" in',
      `      '{{.Id}}') echo ${CONTAINER_ID} ;;`,
      `      *) echo "/$4 status=running started=2026-10-13T07:45:00.1Z finished=2026-10-13T07:30:10.9Z exit=137 oom=false restarts=11 policy=unless-stopped" ;;`,
      '    esac ;;',
      '  events)',
      `    echo "${STOP_EPOCH}${NANOSECONDS} kill 0"`,
      `    echo "${STOP_EPOCH + 10}${NANOSECONDS} die 137"`,
      `    echo "${STOP_EPOCH + 10}${NANOSECONDS} exec_start "`,
      `    echo "${START_EPOCH}${NANOSECONDS} start "`,
      '    ;;',
      `  ps) echo "navneet-${CONTAINER} Up 3 days"; echo "${CONTAINER} Up 5 minutes" ;;`,
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'));
    bin('journalctl', [
      record('journalctl'),
      `echo "Oct 13 07:30:10 host dockerd[1057]: msg=\\"Container failed to exit within 10s of signal 15 - using the force\\" container=${CONTAINER_ID}"`,
      'echo "Oct 13 07:31:00 host dockerd[1057]: msg=\\"restarting\\" container=navneet-controller-server"',
      'echo "Oct 13 07:32:00 host dockerd[1057]: msg=\\"unrelated\\" container=someotherid"',
    ].join('\n'));
    bin('sar', [
      record('sar'),
      'if [[ "$1" == -q ]]; then',
      '  echo "07:20:01   runq-sz  plist-sz   ldavg-1   ldavg-5  ldavg-15   blocked"',
      '  echo "07:30:01        93      4100    101.12    102.40    101.95         3"',
      '  echo "07:40:01         4      3900      9.18     38.20     71.40         0"',
      '  exit',
      'fi',
      'echo "07:30:01     all     36.10      0.00     61.20      0.10      0.00      2.60"',
      'echo "07:40:01     all     30.00      0.00     12.00      0.10      0.00     57.90"',
    ].join('\n'));
  }

  run(args = [], env = {}) {
    return spawnSync('bash', [path.join(this.copyDir, 'run.sh'), ...args], {
      cwd: this.workDir,
      encoding: 'utf8',
      env: { PATH: `${this.binDir}:${process.env.PATH}`, CONTAINER_DIAG_HISTORY_FILES: this.historyFile, ...env },
    });
  }

  calls(command) {
    return fs.readFileSync(this.callsFile, 'utf8').trim().split('\n')
      .filter((line) => line.startsWith(`${command} `))
      .map((line) => line.slice(command.length + 1));
  }
}

// --- helpers ----------------------------------------------------------------------------------

test('container_name rejects shell metacharacters', () => {
  const result = runBash("container_name --container 'controller;reboot'");

  assert.match(result.stderr, /--container must be a container name/);
});

test('iso_to_epoch converts a UTC time to epoch seconds', () => {
  const result = runBash(`iso_to_epoch ${SINCE}`);

  assert.equal(result.stdout, String(SINCE_EPOCH));
});

test('journal_time formats epoch seconds the way journalctl accepts them', () => {
  const result = runBash(`journal_time ${SINCE_EPOCH}`);

  assert.equal(result.stdout, '2026-10-13 05:00:00 UTC');
});

test('name_pattern matches the exact container name only', () => {
  const lines = 'x controller-server y\nnavneet-controller-server\ncontroller-server-old\ncontroller-server';

  const result = runBash(`grep -E "$(name_pattern ${CONTAINER})"`, { input: `${lines}\n` });

  assert.deepEqual(result.stdout.trim().split('\n'), ['x controller-server y', 'controller-server']);
});

test('name_pattern escapes dots in the name', () => {
  const result = runBash('grep -E "$(name_pattern a.b)"', { input: 'axb\na.b\n' });

  assert.equal(result.stdout.trim(), 'a.b');
});

test('sar_start_time for a window that starts today is its UTC clock time', () => {
  const result = runBash(`sar_start_time ${SINCE_EPOCH} ${START_EPOCH}`);

  assert.equal(result.stdout, '05:00:00');
});

test('sar_start_time for a window that starts yesterday is midnight', () => {
  const yesterdayEvening = SINCE_EPOCH - 6 * 3600;

  const result = runBash(`sar_start_time ${yesterdayEvening} ${START_EPOCH}`);

  assert.equal(result.stdout, '00:00:00');
});

// --- end to end -------------------------------------------------------------------------------

test('a run exits 0', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--since', SINCE]);

  assert.equal(result.status, EXIT_OK, result.stderr);
});

test('a run reports the container state with last start, last stop and restarts', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--since', SINCE]);

  assert.match(result.stdout, /\/controller-server status=running started=2026-10-13T07:45:00\.1Z finished=2026-10-13T07:30:10\.9Z exit=137/);
});

test('a run asks docker events for a finite window, never a stream', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--since', SINCE]);

  const eventsCall = scriptRun.calls('docker').find((call) => call.startsWith('events'));
  assert.match(eventsCall, /^events --since 2026-10-13T05:00:00Z --until \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z --filter container=controller-server /);
});

test('a run lists lifecycle events with UTC times and exit codes', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--since', SINCE]);

  assert.match(result.stdout, /2026-10-13T07:30:00Z kill exitCode=0\n2026-10-13T07:30:10Z die exitCode=137\n2026-10-13T07:45:00Z start/);
});

test('a run leaves out non-lifecycle docker events', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--since', SINCE]);

  assert.doesNotMatch(result.stdout, /exec_start/);
});

test('a run reads the dockerd journal for exactly the window', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--since', SINCE]);

  assert.match(scriptRun.calls('journalctl')[0], /^-u docker --since 2026-10-13 05:00:00 UTC --until \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC --no-pager$/);
});

test('a run keeps dockerd journal lines that mention the container id', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--since', SINCE]);

  assert.match(result.stdout, /Container failed to exit within 10s of signal 15/);
});

test('a run drops dockerd journal lines about a similarly named container', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--since', SINCE]);

  assert.doesNotMatch(result.stdout, /container=navneet-controller-server/);
});

test('a run lists only history commands that act on exactly that container', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--since', SINCE]);

  const section = result.stdout.split('===== 4.')[1].split('=====')[1];
  assert.deepEqual(section.trim().split('\n').map((line) => line.split(':').slice(2).join(':')), [
    'docker stop controller-server',
    'docker compose up -d controller-server',
  ]);
});

test('a run shows load history from the start of the window', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--since', SINCE]);

  assert.deepEqual([scriptRun.calls('sar'), /07:40:01 +4 +3900 +9\.18/.test(result.stdout)], [['-q -s 05:00:00', '-u -s 05:00:00'], true]);
});

test('a run shows only the exact container in the final docker ps', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--since', SINCE]);

  assert.match(result.stdout.split('===== 7. now =====')[1], /^\n[^\n]*load average[^\n]*\ncontroller-server Up 5 minutes\n/);
});

test('a run without --since covers the last 6 hours', () => {
  const scriptRun = new ScriptRun();
  const expectedSince = Math.floor(Date.now() / 1000) - DEFAULT_WINDOW_SECONDS;

  const result = scriptRun.run();

  const reported = Date.parse(result.stdout.match(/window: (\S+)/)[1]) / 1000;
  assert.ok(Math.abs(reported - expectedSince) <= WINDOW_TOLERANCE_SECONDS, `${reported} vs ${expectedSince}`);
});

test('a run with --container follows that container', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--since', SINCE, '--container', 'liveclass-server']);

  assert.ok(scriptRun.calls('docker').some((call) => call.includes('--filter container=liveclass-server')));
});

test('a run only ever calls docker inspect, events and ps', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--since', SINCE]);

  const subcommands = new Set(scriptRun.calls('docker').map((call) => call.split(' ')[0]));
  assert.deepEqual([...subcommands].sort(), ['events', 'inspect', 'ps']);
});

test('a run saves the report to one log file under ./logs of the working directory', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--since', SINCE]);

  assert.deepEqual(listFiles(scriptRun.workDir).map((name) => name.replace(/\d{8}T\d{6}Z/, 'TIMESTAMP')), [
    path.join('logs', 'container-events-TIMESTAMP.log'),
  ]);
});

test('a run leaves the shell history file unchanged', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--since', SINCE]);

  assert.equal(fs.readFileSync(scriptRun.historyFile, 'utf8'), `${HISTORY}\n`);
});

test('a run lowers its own CPU priority to nice 19', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--since', SINCE]);

  assert.match(scriptRun.calls('renice').join('\n'), /^-n 19 -p \d+$/m);
});

test('a run while another run holds the lock exits busy', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--since', SINCE], { FAKE_FLOCK_BUSY: '1' });

  assert.equal(result.status, EXIT_BUSY);
});

test('a run when sudo would prompt for a password writes no log', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--since', SINCE], { FAKE_SUDO_DENIED: '1' });

  assert.deepEqual([result.status, listFiles(scriptRun.workDir)], [EXIT_ERROR, []]);
});

test('a run with --since in the future writes no log', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--since', '2099-01-01T00:00:00Z']);

  assert.deepEqual([result.status, listFiles(scriptRun.workDir)], [EXIT_ERROR, []]);
});

test('a run with a malformed --since writes no log', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--since', 'this morning']);

  assert.deepEqual(listFiles(scriptRun.workDir), []);
});

test('a run with an unsafe --container name exits with the configuration error code', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--container', '$(reboot)']);

  assert.equal(result.status, EXIT_ERROR);
});

test('--help prints the usage and exits 0', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--help']);

  assert.match(result.stdout, /READ-ONLY on the host/);
});
