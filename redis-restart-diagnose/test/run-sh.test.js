'use strict';
/**
 * Tests for run.sh: its helper functions (sourced into bash), then whole runs end to end.
 *
 * End-to-end tests copy only the script folder to a temporary place (proving it is standalone)
 * and put fake sudo / pgrep / ps / systemctl / journalctl / redis-cli first on PATH. Redis's
 * own log and the cron files are real files read with the real `tail` and `grep`.
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

const EVENT_TIME = '2026-10-13T05:10:32Z';
const EVENT_EPOCH = 1791868232;
const REDIS_UPTIME_SECONDS = 6074;
const DEFAULT_EVENT_TOLERANCE_SECONDS = 30;
const REDIS_PID = '3565682';
const REDIS_UNIT = 'redis-server.service';

const REDIS_LOG_LINES = [
  '1000:M 13 Oct 2026 04:59:59.000 * outside-before: 10 min 33 s before the event',
  '1000:M 13 Oct 2026 05:10:20.111 # Received SIGTERM scheduling shutdown...',
  '1000:M 13 Oct 2026 05:10:21.000 # Redis is now ready to exit, bye bye...',
  'not a redis log line at all',
  `${REDIS_PID}:C 13 Oct 2026 05:10:32.001 # oO0OoO0OoO0Oo Redis is starting oO0OoO0OoO0Oo`,
  `${REDIS_PID}:M 13 Oct 2026 05:20:00.000 * outside-after: 9 min 28 s after the event`,
];

const CRONTAB = [
  'SHELL=/bin/sh',
  '10 5 * * * root /usr/local/bin/redis-backup.sh',
  '# 0 * * * * root redis-commented-out',
  '17 * * * * root cd / && run-parts --report /etc/cron.hourly',
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'redis-restart-diagnose-'));
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

/** A copy of the script folder, a Redis log and crontab, and fake commands on PATH. */
class ScriptRun {
  constructor() {
    this.root = temporaryDirectory();
    this.copyDir = path.join(this.root, 'copied-script');
    this.workDir = path.join(this.root, 'work');
    this.binDir = path.join(this.root, 'bin');
    this.redisLogDir = path.join(this.root, 'var-log-redis');
    this.redisLog = path.join(this.redisLogDir, 'redis-server.log');
    this.crontab = path.join(this.root, 'crontab');
    this.callsFile = path.join(this.root, 'calls.txt');
    for (const directory of [this.copyDir, this.workDir, this.binDir, this.redisLogDir]) fs.mkdirSync(directory);
    for (const name of SCRIPT_FILES) {
      fs.cpSync(path.join(SCRIPT_DIR, name), path.join(this.copyDir, name), { recursive: true });
    }
    fs.writeFileSync(this.redisLog, `${REDIS_LOG_LINES.join('\n')}\n`);
    fs.writeFileSync(this.crontab, `${CRONTAB}\n`);
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
    bin('pgrep', [record('pgrep'), `[[ "$*" == "-o -x redis-server" ]] && echo ${REDIS_PID}`].join('\n'));
    bin('ps', [
      'unit="${FAKE_UNIT:-' + REDIS_UNIT + '}"',
      'case "$*" in',
      `  *pid,ppid,lstart,unit,args*) echo "    PID    PPID                  STARTED UNIT                 COMMAND"; echo "${REDIS_PID}       1 Tue Oct 13 05:10:32 2026 $unit /usr/bin/redis-server 127.0.0.1:6379" ;;`,
      '  *ppid=*) echo "      1" ;;',
      '  *unit=*) echo "$unit" ;;',
      '  *"pid,args -p 1"*) echo "    PID COMMAND"; echo "      1 /sbin/init" ;;',
      'esac',
    ].join('\n'));
    bin('systemctl', [
      record('systemctl'),
      'if [[ "$1" == show ]]; then printf "Id=%s\\nResult=success\\nRestart=always\\nNRestarts=1\\nExecMainStartTimestamp=Tue 2026-10-13 05:10:32 UTC\\n" "$2"; exit; fi',
      'echo "NEXT LEFT LAST PASSED UNIT ACTIVATES"',
      'echo "Tue 2026-10-13 07:00:00 UTC 8min Tue 2026-10-13 06:00:00 UTC 51min ago logrotate.timer logrotate.service"',
    ].join('\n'));
    bin('journalctl', [
      record('journalctl'),
      'if [[ "$1" == -u ]]; then',
      '  echo "Oct 13 05:10:20 host systemd[1]: Stopping Advanced key-value store..."',
      '  echo "Oct 13 05:10:32 host systemd[1]: Started Advanced key-value store."',
      '  exit',
      'fi',
      'echo "Oct 13 05:10:15 host CRON[123]: (root) CMD (/usr/local/bin/redis-backup.sh)"',
      'echo "Oct 13 05:10:16 host docker[1]: WARN device is not registered, refusing its connections for 600s: X"',
    ].join('\n'));
    bin('redis-cli', [
      record('redis-cli'),
      'shift 4',
      'case "$1 $2" in',
      '  "INFO server") printf "# Server\\r\\nredis_version:6.0.16\\r\\nprocess_supervised:systemd\\r\\nuptime_in_seconds:%s\\r\\nexecutable:/usr/bin/redis-server\\r\\nconfig_file:/etc/redis/redis.conf\\r\\n" "${FAKE_UPTIME:-' + REDIS_UPTIME_SECONDS + '}" ;;',
      '  "INFO memory") printf "used_memory_human:3.90G\\r\\nused_memory_peak_human:7.81G\\r\\nmaxmemory_human:0B\\r\\n" ;;',
      '  "INFO persistence") printf "loading:0\\r\\nrdb_last_bgsave_status:ok\\r\\naof_enabled:0\\r\\n" ;;',
      '  "CONFIG GET")',
      '    case "$3" in',
      `      logfile) printf "logfile\\n%s\\n" "\${FAKE_LOGFILE-${this.redisLog}}" ;;`,
      '      save) printf "save\\n3600 1 300 100 60 10000\\n" ;;',
      '      appendonly) printf "appendonly\\nno\\n" ;;',
      '      maxmemory) printf "maxmemory\\n0\\n" ;;',
      '      maxmemory-policy) printf "maxmemory-policy\\nnoeviction\\n" ;;',
      '    esac ;;',
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'));
  }

  run(args = [], env = {}) {
    return spawnSync('bash', [path.join(this.copyDir, 'run.sh'), ...args], {
      cwd: this.workDir,
      encoding: 'utf8',
      env: { PATH: `${this.binDir}:${process.env.PATH}`, REDIS_DIAG_CRON_PATHS: this.crontab, ...env },
    });
  }

  calls(command) {
    return fs.readFileSync(this.callsFile, 'utf8').trim().split('\n')
      .filter((line) => line.startsWith(`${command} `))
      .map((line) => line.slice(command.length + 1));
  }
}

// --- helpers: settings and time ---------------------------------------------------------------

test('simple_name rejects shell metacharacters', () => {
  const result = runBash("simple_name REDIS_DIAG_REDIS_PROCESS 'redis;reboot'");

  assert.match(result.stderr, /REDIS_DIAG_REDIS_PROCESS must be a plain name/);
});

test('positive_integer with text exits with the configuration error code', () => {
  const result = runBash('positive_integer REDIS_DIAG_REDIS_PORT six');

  assert.equal(result.status, EXIT_ERROR);
});

test('iso_to_epoch converts a UTC time to epoch seconds', () => {
  const result = runBash(`iso_to_epoch ${EVENT_TIME}`);

  assert.equal(result.stdout, String(EVENT_EPOCH));
});

test('epoch_to_iso is the inverse of iso_to_epoch', () => {
  const result = runBash(`epoch_to_iso ${EVENT_EPOCH}`);

  assert.equal(result.stdout, EVENT_TIME);
});

test('journal_time formats epoch seconds the way journalctl accepts them', () => {
  const result = runBash(`journal_time ${EVENT_EPOCH}`);

  assert.equal(result.stdout, '2026-10-13 05:10:32 UTC');
});

// --- helpers: parsing -------------------------------------------------------------------------

test('info_field reads a value from INFO output with CRLF line endings', () => {
  const result = runBash('info_field uptime_in_seconds', { input: '# Server\r\nredis_version:6.0.16\r\nuptime_in_seconds:6074\r\n' });

  assert.equal(result.stdout.trim(), '6074');
});

test('info_field for a missing field prints nothing', () => {
  const result = runBash('info_field uptime_in_seconds', { input: 'NOAUTH Authentication required.\r\n' });

  assert.equal(result.stdout, '');
});

test('config_value prints the value line of CONFIG GET', () => {
  const result = runBash('config_value', { input: 'logfile\r\n/var/log/redis/redis-server.log\r\n' });

  assert.equal(result.stdout.trim(), '/var/log/redis/redis-server.log');
});

test('config_value for an empty setting prints an empty line', () => {
  const result = runBash('config_value', { input: 'logfile\n\n' });

  assert.equal(result.stdout.trim(), '');
});

test('redis_log_lines_between keeps only lines inside the window', () => {
  const windowStart = EVENT_EPOCH - 10 * 60;
  const windowEnd = EVENT_EPOCH + 5 * 60;

  const result = runBash(`redis_log_lines_between ${windowStart} ${windowEnd}`, { input: `${REDIS_LOG_LINES.join('\n')}\n` });

  assert.deepEqual(result.stdout.trim().split('\n'), [REDIS_LOG_LINES[1], REDIS_LOG_LINES[2], REDIS_LOG_LINES[4]]);
});

test('redis_log_lines_between includes lines exactly on the window edges', () => {
  const line = `${REDIS_PID}:M 13 Oct 2026 05:10:32.999 * edge`;

  const result = runBash(`redis_log_lines_between ${EVENT_EPOCH} ${EVENT_EPOCH}`, { input: `${line}\n` });

  assert.equal(result.stdout.trim(), line);
});

// --- end to end -------------------------------------------------------------------------------

test('a run exits 0', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--event-time', EVENT_TIME]);

  assert.equal(result.status, EXIT_OK, result.stderr);
});

test('a run with --event-time reports that event', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--event-time', EVENT_TIME]);

  assert.match(result.stdout, /event \(Redis restart\): 2026-10-13T05:10:32Z/);
});

test('a run without --event-time uses now minus Redis uptime', () => {
  const scriptRun = new ScriptRun();
  const expectedEpoch = Math.floor(Date.now() / 1000) - REDIS_UPTIME_SECONDS;

  const result = scriptRun.run();

  const reported = Date.parse(result.stdout.match(/event \(Redis restart\): (\S+)/)[1]) / 1000;
  assert.ok(Math.abs(reported - expectedEpoch) <= DEFAULT_EVENT_TOLERANCE_SECONDS, `${reported} vs ${expectedEpoch}`);
});

test('a run without --event-time and with no readable uptime exits with the configuration error code', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run([], { FAKE_UPTIME: 'NOAUTH' });

  assert.equal(result.status, EXIT_ERROR);
});

test('a run finds the server process with pgrep -o -x, not a bgsave child', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--event-time', EVENT_TIME]);

  assert.deepEqual(scriptRun.calls('pgrep'), ['-o -x redis-server']);
});

test('a run shows the systemd properties of the Redis unit', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--event-time', EVENT_TIME]);

  assert.match(result.stdout, /Id=redis-server\.service\nResult=success\nRestart=always\nNRestarts=1/);
});

test('a run reads the unit journal for exactly 10 min before to 5 min after', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--event-time', EVENT_TIME]);

  assert.ok(scriptRun.calls('journalctl').includes(
    `-u ${REDIS_UNIT} --since 2026-10-13 05:00:32 UTC --until 2026-10-13 05:15:32 UTC --no-pager`,
  ));
});

test('a run reads the whole system journal for exactly 60 s before to 20 s after', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--event-time', EVENT_TIME]);

  assert.ok(scriptRun.calls('journalctl').includes('--since 2026-10-13 05:09:32 UTC --until 2026-10-13 05:10:52 UTC --no-pager'));
});

test('a run hides the refusing-connections noise from the system journal', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--event-time', EVENT_TIME]);

  assert.doesNotMatch(result.stdout, /refusing its connections/);
});

test('a run when Redis is not a systemd service skips the unit journal', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--event-time', EVENT_TIME], { FAKE_UNIT: 'session-5.scope' });

  assert.ok(scriptRun.calls('journalctl').every((call) => !call.startsWith('-u ')));
});

test('a run when Redis is not a systemd service says so', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--event-time', EVENT_TIME], { FAKE_UNIT: 'session-5.scope' });

  assert.match(result.stdout, /Redis is not running as a systemd service/);
});

test('a run shows the Redis shutdown reason from its own log', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--event-time', EVENT_TIME]);

  assert.match(result.stdout, /# Received SIGTERM scheduling shutdown/);
});

test('a run leaves out Redis log lines outside the window', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--event-time', EVENT_TIME]);

  assert.doesNotMatch(result.stdout, /outside-(before|after)/);
});

test('a run when Redis logs to stdout points to the journal instead', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--event-time', EVENT_TIME], { FAKE_LOGFILE: '' });

  assert.match(result.stdout, /logfile is empty: Redis logs to stdout/);
});

test('a run lists active cron lines that mention redis', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--event-time', EVENT_TIME]);

  assert.match(result.stdout, /2:10 5 \* \* \* root \/usr\/local\/bin\/redis-backup\.sh/);
});

test('a run leaves out commented-out cron lines', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--event-time', EVENT_TIME]);

  assert.doesNotMatch(result.stdout, /redis-commented-out/);
});

test('a run shows the Redis memory cap', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--event-time', EVENT_TIME]);

  assert.match(result.stdout, /maxmemory = 0\n/);
});

test('a run only ever calls redis-cli INFO and CONFIG GET', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--event-time', EVENT_TIME]);

  const commands = new Set(scriptRun.calls('redis-cli').map((call) => call.split(' ').slice(4, 6).join(' ')));
  assert.ok([...commands].every((command) => command.startsWith('INFO ') || command.startsWith('CONFIG GET')), [...commands].join(', '));
});

test('a run saves the report to one log file under ./logs of the working directory', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--event-time', EVENT_TIME]);

  assert.deepEqual(listFiles(scriptRun.workDir).map((name) => name.replace(/\d{8}T\d{6}Z/, 'TIMESTAMP')), [
    path.join('logs', 'redis-restart-TIMESTAMP.log'),
  ]);
});

test('a run leaves the Redis log file unchanged', () => {
  const scriptRun = new ScriptRun();
  const before = fs.readFileSync(scriptRun.redisLog, 'utf8');

  scriptRun.run(['--event-time', EVENT_TIME]);

  assert.equal(fs.readFileSync(scriptRun.redisLog, 'utf8'), before);
});

test('a run lowers its own CPU priority to nice 19', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--event-time', EVENT_TIME]);

  assert.match(scriptRun.calls('renice').join('\n'), /^-n 19 -p \d+$/m);
});

test('a run while another run holds the lock exits busy', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--event-time', EVENT_TIME], { FAKE_FLOCK_BUSY: '1' });

  assert.equal(result.status, EXIT_BUSY);
});

test('a run when sudo would prompt for a password writes no log', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--event-time', EVENT_TIME], { FAKE_SUDO_DENIED: '1' });

  assert.deepEqual([result.status, listFiles(scriptRun.workDir)], [EXIT_ERROR, []]);
});

test('a run with a malformed --event-time writes no log', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run(['--event-time', '05:10 today']);

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

  assert.match(result.stdout, /READ-ONLY on the host/);
});
