'use strict';
/**
 * Tests for run.sh: its helper functions (sourced into bash), then whole runs end to end.
 *
 * End-to-end tests copy only the script folder to a temporary place (proving it is standalone)
 * and put fake sudo / docker / journalctl / nsenter / ss / redis-cli / ps / last / pgrep first
 * on PATH. The nginx json log is a real file read with the real `tail`.
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

const CONTROLLER_STARTED_AT = '2026-10-13T05:10:39.506757063Z';
const CONTROLLER_STARTED_EPOCH = '1791868239';
const NGINX_PID = '4242';
const CONTROLLER_UPSTREAM = '172.18.0.9:7101';
const LIVECLASS_UPSTREAM = '172.18.0.12:80';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingress-herd-diagnose-'));
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

/** One docker json-file line wrapping `text` (quotes escaped as docker does). */
function jsonLogLine(text, time, stream = 'stdout') {
  return JSON.stringify({ log: `${text}\n`, stream, time });
}

function accessLine(status, requestPath, time) {
  return jsonLogLine(
    `172.18.0.1 - - [13/Oct/2026:06:15:00 +0000] "GET ${requestPath} HTTP/1.1" ${status} 12 "-" "okhttp/3.12.0"`,
    time,
  );
}

function upstreamErrorLine(error, upstream, time) {
  return jsonLogLine(
    `2026/10/13 06:15:01 [error] 31#31: *1 ${error} while reading response header from upstream, client: 172.18.0.1, request: "GET /a HTTP/1.1", upstream: "http://${upstream}/a", host: "y"`,
    time,
    'stderr',
  );
}

const NGINX_LOG_LINES = [
  accessLine(200, '/socket.io/?EIO=3&transport=polling', '2026-10-13T06:15:00.000000001Z'),
  accessLine(200, '/socket.io/?EIO=3&transport=polling', '2026-10-13T06:15:00.000000002Z'),
  accessLine(504, '/controller/devices', '2026-10-13T06:15:00.000000003Z'),
  upstreamErrorLine('upstream timed out (110: Connection timed out)', CONTROLLER_UPSTREAM, '2026-10-13T06:15:01.000000000Z'),
  upstreamErrorLine('upstream timed out (110: Connection timed out)', CONTROLLER_UPSTREAM, '2026-10-13T06:15:01.500000000Z'),
  upstreamErrorLine('connect() failed (111: Connection refused)', LIVECLASS_UPSTREAM, '2026-10-13T06:15:02.000000000Z'),
  accessLine(101, '/live-class-server-socket/?EIO=4', '2026-10-13T06:15:03.000000000Z'),
];

/** A copy of the script folder, a fake nginx json log, and fake commands on PATH. */
class ScriptRun {
  constructor() {
    this.root = temporaryDirectory();
    this.copyDir = path.join(this.root, 'copied-script');
    this.workDir = path.join(this.root, 'work');
    this.binDir = path.join(this.root, 'bin');
    this.nginxLog = path.join(this.root, 'nginx-json.log');
    this.callsFile = path.join(this.root, 'calls.txt');
    for (const directory of [this.copyDir, this.workDir, this.binDir]) fs.mkdirSync(directory);
    for (const name of SCRIPT_FILES) {
      fs.cpSync(path.join(SCRIPT_DIR, name), path.join(this.copyDir, name), { recursive: true });
    }
    fs.writeFileSync(this.nginxLog, `${NGINX_LOG_LINES.join('\n')}\n`);
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
    bin('docker', [
      record('docker'),
      'case "$1" in',
      '  inspect)',
      '    case "$3" in',
      `      *LogPath*) echo ${shellQuote(this.nginxLog)} ;;`,
      `      *State.Pid*) echo ${NGINX_PID} ;;`,
      '      *previous_exit*) echo "/$4 started=2026-10-13T05:10:39.5Z previous_exit=2026-10-13T05:10:37.1Z restarts=11 policy=unless-stopped" ;;',
      '      *IPAddress*) echo "/$4 172.18.0.9 " ;;',
      `      '{{.State.StartedAt}}') echo ${CONTROLLER_STARTED_AT} ;;`,
      '      *) exit 1 ;;',
      '    esac ;;',
      '  logs)',
      '    echo "[Nest] 1 ERROR Redis connection lost: connect ECONNREFUSED 127.0.0.1:6379"',
      '    echo "[Nest] 1 WARN device is not registered, refusing its connections for 600s: ABC" ;;',
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'));
    bin('journalctl', [
      record('journalctl'),
      'if [[ "$1" == -k ]]; then echo "Oct 13 05:10:30 host kernel: Out of memory: Killed process 3400000 (redis-server)"; exit; fi',
      'if [[ "$2" == redis-server ]]; then echo "Oct 13 05:10:31 host systemd[1]: redis-server.service: Main process exited, code=killed, status=9/KILL"; exit; fi',
      'echo "Oct 13 05:10:38 host dockerd[1057]: level=info msg=\\"restarting container\\" container=controller-server"',
    ].join('\n'));
    bin('pidof', '[[ "$1" == redis-server ]] && echo 3565682');
    bin('ps', 'echo "    PID                  STARTED     ELAPSED COMMAND"; echo "3565682 Tue Oct 13 05:10:32 2026    01:12:00 /usr/bin/redis-server 127.0.0.1:6379"');
    bin('redis-cli', 'echo "uptime_in_seconds:4320"');
    bin('last', 'echo "ubuntu   pts/0  100.122.95.2  Tue Oct 13 05:55:00 2026   still logged in"');
    bin('nsenter', [
      record('nsenter'),
      'shift 3',
      'exec "$@"',
    ].join('\n'));
    bin('ss', [
      'if [[ "$*" == *"state established"* ]]; then',
      '  echo "Recv-Q Send-Q Local:Port Peer:Port"',
      `  for i in 1 2 3; do echo "0 0 172.18.0.24:4100$i ${CONTROLLER_UPSTREAM}"; done`,
      `  echo "0 0 172.18.0.24:42000 ${LIVECLASS_UPSTREAM}"`,
      '  exit',
      'fi',
      'echo "State Recv-Q Send-Q Local:Port Peer:Port"',
      'for i in 1 2; do echo "CLOSE-WAIT 0 0 a b"; done',
      'echo "ESTAB 0 0 a b"',
    ].join('\n'));
    bin('pgrep', 'exit 1');
  }

  run(args = [], env = {}) {
    return spawnSync('bash', [path.join(this.copyDir, 'run.sh'), ...args], {
      cwd: this.workDir,
      encoding: 'utf8',
      env: { PATH: `${this.binDir}:${process.env.PATH}`, ...env },
    });
  }

  calls(command) {
    return fs.readFileSync(this.callsFile, 'utf8').trim().split('\n')
      .filter((line) => line.startsWith(`${command} `))
      .map((line) => line.slice(command.length + 1));
  }
}

// --- helpers: settings ------------------------------------------------------------------------

test('positive_integer with zero exits with the configuration error code', () => {
  const result = runBash('positive_integer SETTING 0');

  assert.equal(result.status, EXIT_ERROR);
});

test('container_names accepts space-separated docker names', () => {
  const result = runBash("container_names SETTING 'controller-server broadcast-server'");

  assert.equal(result.stdout, 'controller-server broadcast-server');
});

test('container_names rejects shell metacharacters', () => {
  const result = runBash("container_names INGRESS_DIAG_SOCKET_CONTAINERS 'controller;reboot'");

  assert.match(result.stderr, /INGRESS_DIAG_SOCKET_CONTAINERS must be space-separated container names/);
});

test('load_env_file exports an INGRESS_DIAG_ setting from the file', () => {
  const envFile = path.join(temporaryDirectory(), '.env');
  fs.writeFileSync(envFile, 'INGRESS_DIAG_MINUTES_BEFORE=45 # wider\n');

  const result = runBash(`load_env_file ${shellQuote(envFile)}; printf %s "$INGRESS_DIAG_MINUTES_BEFORE"`);

  assert.equal(result.stdout, '45');
});

test('load_env_file keeps a value already exported in the shell', () => {
  const envFile = path.join(temporaryDirectory(), '.env');
  fs.writeFileSync(envFile, 'INGRESS_DIAG_MINUTES_BEFORE=45\n');

  const result = runBash(
    `load_env_file ${shellQuote(envFile)}; printf %s "$INGRESS_DIAG_MINUTES_BEFORE"`,
    { env: { INGRESS_DIAG_MINUTES_BEFORE: '20' } },
  );

  assert.equal(result.stdout, '20');
});

// --- helpers: time ----------------------------------------------------------------------------

test('iso_to_epoch converts a UTC time to epoch seconds', () => {
  const result = runBash('iso_to_epoch 2026-10-13T05:10:39Z');

  assert.equal(result.stdout, CONTROLLER_STARTED_EPOCH);
});

test('iso_to_epoch ignores fractional seconds', () => {
  const result = runBash(`iso_to_epoch ${CONTROLLER_STARTED_AT}`);

  assert.equal(result.stdout, CONTROLLER_STARTED_EPOCH);
});

test('iso_to_epoch handles a leap day', () => {
  const result = runBash('iso_to_epoch 2024-02-29T00:00:00Z');

  assert.equal(result.stdout, '1709164800');
});

test('iso_to_epoch handles the epoch itself', () => {
  const result = runBash('iso_to_epoch 1970-01-01T00:00:00Z');

  assert.equal(result.stdout, '0');
});

test('iso_to_epoch without the UTC Z suffix exits with the configuration error code', () => {
  const result = runBash('iso_to_epoch 2026-10-13T05:10:39');

  assert.equal(result.status, EXIT_ERROR);
});

test('epoch_to_iso formats epoch seconds as a UTC time', () => {
  const result = runBash('epoch_to_iso 951955199');

  assert.equal(result.stdout, '2000-03-01T23:59:59Z');
});

test('journal_time formats epoch seconds the way journalctl accepts them', () => {
  const result = runBash(`journal_time ${CONTROLLER_STARTED_EPOCH}`);

  assert.equal(result.stdout, '2026-10-13 05:10:39 UTC');
});

// --- helpers: log parsing ---------------------------------------------------------------------

test('json_log_window prints the first and last timestamps', () => {
  const result = runBash('json_log_window', { input: `${NGINX_LOG_LINES.join('\n')}\n` });

  assert.equal(result.stdout, 'from 2026-10-13T06:15:00\nto   2026-10-13T06:15:03\n');
});

test('json_log_window on an empty log prints nothing', () => {
  const result = runBash('json_log_window', { input: '' });

  assert.equal(result.stdout, '');
});

test('nginx_status_paths prints status and path without the query string', () => {
  const result = runBash('nginx_status_paths', { input: `${NGINX_LOG_LINES[0]}\n` });

  assert.equal(result.stdout.trim(), '200 /socket.io/');
});

test('nginx_upstream_errors pairs a json-log error with its upstream', () => {
  const result = runBash('nginx_upstream_errors', { input: `${NGINX_LOG_LINES[3]}\n` });

  assert.equal(result.stdout.trim(), `upstream timed out -> ${CONTROLLER_UPSTREAM}`);
});

test('nginx_upstream_errors pairs a raw-log error with its upstream', () => {
  const rawLine = `2026/10/13 06:15:01 [error] connect() failed (111), upstream: "http://${LIVECLASS_UPSTREAM}/x", host: "y"`;

  const result = runBash('nginx_upstream_errors', { input: `${rawLine}\n` });

  assert.equal(result.stdout.trim(), `connect() failed -> ${LIVECLASS_UPSTREAM}`);
});

test('nginx_upstream_errors marks an unresolved upstream with a dash', () => {
  const rawLine = '2026/10/13 06:15:02 [error] controller-server could not be resolved (2: Server failure)';

  const result = runBash('nginx_upstream_errors', { input: `${rawLine}\n` });

  assert.equal(result.stdout.trim(), 'could not be resolved -> -');
});

test('count_ranked lists the most frequent lines first, up to the limit', () => {
  const result = runBash('count_ranked 2', { input: 'b\na\nb\nc\nb\na\n' });

  assert.deepEqual(result.stdout.trim().split('\n').map((line) => line.trim()), ['3 b', '2 a']);
});

// --- end to end -------------------------------------------------------------------------------

test('a run exits 0', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.equal(result.status, EXIT_OK, result.stderr);
});

test('a run without --event-time uses controller-server start time and the default window', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, /event: 2026-10-13T05:10:39Z   window: 2026-10-13 04:50:39 UTC \.\. 2026-10-13 05:20:39 UTC/);
});

test('a run with --event-time uses that time', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--event-time', '2026-10-13T05:00:00Z']);

  assert.match(result.stdout, /event: 2026-10-13T05:00:00Z   window: 2026-10-13 04:40:00 UTC/);
});

test('a run queries the kernel journal for exactly the event window', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run();

  assert.ok(scriptRun.calls('journalctl').includes(
    '-k --since 2026-10-13 04:50:39 UTC --until 2026-10-13 05:20:39 UTC --no-pager',
  ));
});

test('a run reports the kernel OOM kill in the window', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, /A3\. kernel OOM kills[^\n]*\n[^\n]*Killed process 3400000 \(redis-server\)/);
});

test('a run reads the socket servers logs only in a bounded window around the event', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run();

  assert.deepEqual(scriptRun.calls('docker').filter((call) => call.startsWith('logs')), [
    'logs --since 2026-10-13T05:08:39Z --until 2026-10-13T05:10:49Z controller-server',
    'logs --since 2026-10-13T05:08:39Z --until 2026-10-13T05:10:49Z broadcast-server',
  ]);
});

test('a run hides the refusing-connections noise from the socket server logs', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.doesNotMatch(result.stdout, /refusing its connections/);
});

test('a run only ever calls docker inspect and docker logs', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run();

  const subcommands = new Set(scriptRun.calls('docker').map((call) => call.split(' ')[0]));
  assert.deepEqual([...subcommands].sort(), ['inspect', 'logs']);
});

test('a run ranks nginx requests by status and path', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, /2 200 \/socket\.io\//);
});

test('a run ranks nginx upstream errors with the holder first', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, new RegExp(`2 upstream timed out -> ${CONTROLLER_UPSTREAM}\\n\\s+1 connect\\(\\) failed -> ${LIVECLASS_UPSTREAM}`));
});

test('a run counts established nginx connections per upstream inside the nginx namespace', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, new RegExp(`3 ${CONTROLLER_UPSTREAM}`));
});

test('a run enters the nginx container network namespace by its pid', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run();

  assert.ok(scriptRun.calls('nsenter').every((call) => call.startsWith(`-t ${NGINX_PID} -n ss -tan`)));
});

test('a run reports no leftover docker logs readers', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, /leftover docker logs readers[^\n]*\nnone\n/);
});

test('a run saves the report to one log file under ./logs of the working directory', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run();

  assert.deepEqual(listFiles(scriptRun.workDir).map((name) => name.replace(/\d{8}T\d{6}Z/, 'TIMESTAMP')), [
    path.join('logs', 'ingress-herd-TIMESTAMP.log'),
  ]);
});

test('a run leaves the nginx log file unchanged', () => {
  const scriptRun = new ScriptRun();
  const before = fs.readFileSync(scriptRun.nginxLog, 'utf8');

  scriptRun.run();

  assert.equal(fs.readFileSync(scriptRun.nginxLog, 'utf8'), before);
});

test('a run lowers its own CPU priority to nice 19', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run();

  assert.match(scriptRun.calls('renice').join('\n'), /^-n 19 -p \d+$/m);
});

test('a run while another run holds the lock exits busy', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run([], { FAKE_FLOCK_BUSY: '1' });

  assert.equal(result.status, EXIT_BUSY);
});

test('a run when sudo would prompt for a password exits with the configuration error code', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run([], { FAKE_SUDO_DENIED: '1' });

  assert.equal(result.status, EXIT_ERROR);
});

test('a run when sudo would prompt for a password writes no log', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run([], { FAKE_SUDO_DENIED: '1' });

  assert.deepEqual(listFiles(scriptRun.workDir), []);
});

test('a run with a malformed --event-time writes no log', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--event-time', '13/10/2026 05:10']);

  assert.deepEqual(listFiles(scriptRun.workDir), []);
});

test('a run with an unknown argument exits with the configuration error code', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--restart']);

  assert.equal(result.status, EXIT_ERROR);
});

test('--help prints the usage and exits 0', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--help']);

  assert.match(result.stdout, /READ-ONLY on the host/);
});
