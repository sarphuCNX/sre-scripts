'use strict';
/**
 * Tests for run.sh: its helper functions (sourced into bash), then whole runs end to end.
 *
 * End-to-end tests copy only the script folder to a temporary place (proving it is standalone),
 * point it at a fake /proc and /sys, and put fake top / ss / ps / docker / pidof first on PATH.
 * The fake `sleep` swaps in the "after" /proc counters so rates are deterministic.
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
const PLANNED_WINDOW_SECONDS = 10;
const SLOW_WINDOW_SECONDS = 20;
const SHORT_COMMAND_TIMEOUT = '1';
// A hung ps sleeps HANG_SECONDS; a bounded run must finish well inside it. The budget is
// generous because each fake command takes ~0.5 s to start on macOS (first-exec scan).
const HANG_SECONDS = 60;
const HANG_TEST_BUDGET_MS = 20000;

const DOCKERD_PID = '1057';
const APP_PID = '3566440';
const ZOMBIE_PARENT_PID = '276876';
const APP_CONTAINER_ID = 'a'.repeat(64);
const MEDIA_CONTAINER_ID = 'b'.repeat(64);
const UNKNOWN_CONTAINER_ID = 'c'.repeat(64);

// --- helpers ----------------------------------------------------------------------------------

/** Quote a value for bash with single quotes. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Source run.sh (main does not run when sourced) and run `script` in bash. */
function runBash(script, env = {}) {
  return spawnSync('bash', ['-c', `source ${shellQuote(RUN_SH)}; ${script}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
}

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'host-cpu-diagnose-'));
}

/** Write FILES ({relativePath: content}) under ROOT. */
function writeTree(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
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

function procStat({ user, system, idle, iowait, softirq, forks }) {
  return `cpu  ${user} 0 ${system} ${idle} ${iowait} 0 ${softirq} 0 0 0\ncpu0 1 0 1 1 0 0 0 0 0 0\nprocesses ${forks}\n`;
}

function netstat({ drops, overflows }) {
  return `TcpExt: SyncookiesSent ListenOverflows ListenDrops\nTcpExt: 0 ${overflows} ${drops}\nIpExt: InNoRoutes\nIpExt: 0\n`;
}

function softirqs(perCpu) {
  return `                    CPU0       CPU1\n      NET_TX:          1          1\n      NET_RX: ${perCpu.join(' ')}\n`;
}

function processStat(utime, stime) {
  return `${DOCKERD_PID} (docker d) S 1 1 1 0 -1 0 0 0 0 0 ${utime} ${stime} 0 0 20 0\n`;
}

function vmstat({ scans, stalls }) {
  return `nr_free_pages 100\npgscan_kswapd ${scans}\nallocstall_normal ${stalls}\n`;
}

const TOP_OUTPUT = [
  'top - 05:50:01 up 96 days,  load average: 9.0, 9.0, 9.0',
  'Tasks: 10 total',
  '%Cpu(s): 50.0 us, 50.0 sy',
  'MiB Mem :  1000.0 total',
  'MiB Swap:  100.0 total',
  '',
  '    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND',
  `${APP_PID} root      20   0       1      1      1 S   1.0   0.1   0:01.00 stale-first-sample`,
  'top - 05:50:06 up 96 days,  load average: 105.5, 102.0, 98.1',
  'Tasks: 1129 total',
  '%Cpu(s): 22.0 us, 75.0 sy',
  'MiB Mem :  31334.0 total',
  'MiB Swap:   4096.0 total',
  '',
  '    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND',
  `${APP_PID} root      20   0 1000000 440000  30000 S  91.2   1.4  50:00.00 node`,
  `${DOCKERD_PID} root      20   0 5000000 500000  50000 S  12.5   1.6 900:00.00 dockerd`,
].join('\n');

/**
 * A copy of the script folder, a fake /proc and /sys, and fake commands on PATH.
 * `elapsedSeconds` is how far the fake /proc/uptime advances across the sample window.
 */
class ScriptRun {
  constructor({ elapsedSeconds = PLANNED_WINDOW_SECONDS } = {}) {
    this.elapsedSeconds = elapsedSeconds;
    this.root = temporaryDirectory();
    this.copyDir = path.join(this.root, 'copied-script');
    this.workDir = path.join(this.root, 'work');
    this.procRoot = path.join(this.root, 'proc');
    this.procAfter = path.join(this.root, 'proc-after');
    this.sysRoot = path.join(this.root, 'sys');
    this.binDir = path.join(this.root, 'bin');
    this.dockerCalls = path.join(this.root, 'docker-calls.txt');
    this.priorityCalls = path.join(this.root, 'priority-calls.txt');
    for (const directory of [this.copyDir, this.workDir, this.binDir]) fs.mkdirSync(directory);
    for (const name of SCRIPT_FILES) {
      fs.cpSync(path.join(SCRIPT_DIR, name), path.join(this.copyDir, name), { recursive: true });
    }
    fs.writeFileSync(this.dockerCalls, '');
    fs.writeFileSync(this.priorityCalls, '');
    this.writeProc();
    this.writeFakeCommands();
  }

  writeProc() {
    const shared = {
      [`${APP_PID}/cgroup`]: `0::/system.slice/docker-${APP_CONTAINER_ID}.scope\n`,
      [`${ZOMBIE_PARENT_PID}/cgroup`]: `12:pids:/docker/${MEDIA_CONTAINER_ID}\n`,
      [`${DOCKERD_PID}/cgroup`]: '0::/system.slice/docker.service\n',
    };
    writeTree(this.procRoot, {
      ...shared,
      uptime: '1000.00 8000.00\n',
      stat: procStat({ user: 1000, system: 1000, idle: 1000, iowait: 0, softirq: 0, forks: 5000 }),
      'net/netstat': netstat({ drops: 100, overflows: 50 }),
      softirqs: softirqs([1000, 1000]),
      vmstat: vmstat({ scans: 0, stalls: 0 }),
      [`${DOCKERD_PID}/stat`]: processStat(1000, 1000),
    });
    writeTree(this.procAfter, {
      uptime: `${(1000 + this.elapsedSeconds).toFixed(2)} 8000.00\n`,
      stat: procStat({ user: 1200, system: 1700, idle: 1000, iowait: 0, softirq: 100, forks: 5060 }),
      'net/netstat': netstat({ drops: 96100, overflows: 150 }),
      softirqs: softirqs([151000, 151000]),
      vmstat: vmstat({ scans: 5000, stalls: 30 }),
      [`${DOCKERD_PID}/stat`]: processStat(1050, 1050),
    });
    writeTree(this.sysRoot, {
      'kernel/mm/transparent_hugepage/enabled': 'always [madvise] never\n',
      'kernel/mm/transparent_hugepage/defrag': 'always defer [madvise] never\n',
    });
  }

  writeFakeCommands() {
    const bin = (name, body) => writeExecutable(path.join(this.binDir, name), body);
    bin('sleep', `cp -R ${shellQuote(this.procAfter)}/. ${shellQuote(this.procRoot)}/`);
    // A working timeout: SIGALRM (which survives exec) kills the command after the limit.
    bin('timeout', [
      '[[ "$1" == -k ]] && shift 2',
      'limit="$1"; shift',
      'exec perl -e \'alarm shift; exec @ARGV or die "exec: $!"\' "$limit" "$@"',
    ].join('\n'));
    bin('renice', `printf 'renice %s\\n' "$*" >> ${shellQuote(this.priorityCalls)}`);
    bin('ionice', `printf 'ionice %s\\n' "$*" >> ${shellQuote(this.priorityCalls)}`);
    bin('flock', '[[ "${FAKE_FLOCK_BUSY:-0}" == 1 ]] && exit 1; exit 0');
    bin('docker', [
      `printf '%s\\n' "$*" >> ${shellQuote(this.dockerCalls)}`,
      `[[ "$1" == ps ]] || exit 1`,
      `printf '%s %s\\n' ${APP_CONTAINER_ID} kneura-web-teach-server-pm2 ${MEDIA_CONTAINER_ID} navneet-media-converter-server`,
    ].join('\n'));
    bin('top', `[[ "\${FAKE_TOP_FAIL:-0}" == 1 ]] && exit 1\ncat <<'EOF'\n${TOP_OUTPUT}\nEOF`);
    bin('ss', [
      'if [[ "$1" == -s ]]; then printf "Total: 30000\\nTCP:   29000 (estab 24000)\\n"; exit; fi',
      'printf "State Recv-Q Send-Q Local Peer\\n"',
      'for i in 1 2 3; do echo "ESTAB 0 0 x y"; done',
      'echo "SYN-RECV 0 0 x y"',
    ].join('\n'));
    bin('ps', [
      'if [[ "$*" == "-eo ppid=,stat=" ]]; then',
      `  for i in 1 2 3; do echo " ${ZOMBIE_PARENT_PID} Z"; done`,
      '  echo " 3074198 Z"; echo " 1 Ss"; exit',
      'fi',
      `[[ "\${FAKE_PS_HANG:-0}" == 1 ]] && exec /bin/sleep ${HANG_SECONDS}`,
      'echo " 14-02:03:04 npm start"',
    ].join('\n'));
    bin('pidof', `[[ "$1" == dockerd ]] && echo ${DOCKERD_PID}`);
    bin('getconf', 'echo 100');
    bin('hostname', 'echo BrightClass-Production');
    bin('uptime', 'echo " 05:50:06 up 96 days,  load average: 105.54, 102.02, 98.12"');
    bin('free', 'echo "Mem: 30Gi 28Gi 434Mi"');
  }

  run(args = [], env = {}) {
    return spawnSync('bash', [path.join(this.copyDir, 'run.sh'), ...args], {
      cwd: this.workDir,
      encoding: 'utf8',
      env: {
        PATH: `${this.binDir}:${process.env.PATH}`,
        HOST_CPU_DIAG_PROC_ROOT: this.procRoot,
        HOST_CPU_DIAG_SYS_ROOT: this.sysRoot,
        ...env,
      },
    });
  }

  priorityCommands() {
    return fs.readFileSync(this.priorityCalls, 'utf8').trim().split('\n').filter(Boolean);
  }

  dockerCommands() {
    return fs.readFileSync(this.dockerCalls, 'utf8').trim().split('\n').filter(Boolean);
  }
}

// --- helpers: positive_integer ----------------------------------------------------------------

test('positive_integer with a whole number prints it', () => {
  const result = runBash('positive_integer SETTING 15');

  assert.equal(result.stdout, '15');
});

test('positive_integer with zero exits with the configuration error code', () => {
  const result = runBash('positive_integer SETTING 0');

  assert.equal(result.status, EXIT_ERROR);
});

test('positive_integer with text names the setting in the error', () => {
  const result = runBash('positive_integer HOST_CPU_DIAG_SAMPLE_SECONDS ten');

  assert.match(result.stderr, /HOST_CPU_DIAG_SAMPLE_SECONDS must be a whole number above 0, got 'ten'/);
});

// --- helpers: load_env_file -------------------------------------------------------------------

test('load_env_file exports a HOST_CPU_DIAG_ setting from the file', () => {
  const envFile = path.join(temporaryDirectory(), '.env');
  fs.writeFileSync(envFile, 'HOST_CPU_DIAG_FRONT_DOOR_PORT=7101 # proxy\n');

  const result = runBash(`load_env_file ${shellQuote(envFile)}; printf %s "$HOST_CPU_DIAG_FRONT_DOOR_PORT"`);

  assert.equal(result.stdout, '7101');
});

test('load_env_file keeps a value already exported in the shell', () => {
  const envFile = path.join(temporaryDirectory(), '.env');
  fs.writeFileSync(envFile, 'HOST_CPU_DIAG_FRONT_DOOR_PORT=7101\n');

  const result = runBash(
    `load_env_file ${shellQuote(envFile)}; printf %s "$HOST_CPU_DIAG_FRONT_DOOR_PORT"`,
    { HOST_CPU_DIAG_FRONT_DOOR_PORT: '6080' },
  );

  assert.equal(result.stdout, '6080');
});

test('load_env_file ignores variables without the HOST_CPU_DIAG_ prefix', () => {
  const envFile = path.join(temporaryDirectory(), '.env');
  fs.writeFileSync(envFile, 'OTHER_SETTING=surprise\n');

  const result = runBash(`load_env_file ${shellQuote(envFile)}; printf %s "\${OTHER_SETTING:-unset}"`);

  assert.equal(result.stdout, 'unset');
});

// --- helpers: container mapping ---------------------------------------------------------------

test('cgroup_container_id reads the id from a cgroup v2 docker scope line', () => {
  const directory = temporaryDirectory();
  writeTree(directory, { cgroup: `0::/system.slice/docker-${APP_CONTAINER_ID}.scope\n` });

  const result = runBash(`cgroup_container_id ${shellQuote(path.join(directory, 'cgroup'))}`);

  assert.equal(result.stdout.trim(), APP_CONTAINER_ID);
});

test('cgroup_container_id reads the id from a cgroup v1 docker path', () => {
  const directory = temporaryDirectory();
  writeTree(directory, { cgroup: `12:pids:/docker/${MEDIA_CONTAINER_ID}\n` });

  const result = runBash(`cgroup_container_id ${shellQuote(path.join(directory, 'cgroup'))}`);

  assert.equal(result.stdout.trim(), MEDIA_CONTAINER_ID);
});

test('cgroup_container_id for a host process prints nothing', () => {
  const directory = temporaryDirectory();
  writeTree(directory, { cgroup: '0::/system.slice/docker.service\n' });

  const result = runBash(`cgroup_container_id ${shellQuote(path.join(directory, 'cgroup'))}`);

  assert.equal(result.stdout, '');
});

test('cgroup_container_id for a process that has exited prints nothing', () => {
  const missingFile = path.join(temporaryDirectory(), 'gone', 'cgroup');

  const result = runBash(`cgroup_container_id ${shellQuote(missingFile)}`);

  assert.equal(result.stdout, '');
});

test('container_name with no container id prints host', () => {
  const result = runBash(`container_name '' ${shellQuote(`${APP_CONTAINER_ID} kneura`)}`);

  assert.equal(result.stdout, 'host');
});

test('container_name with a listed id prints the container name', () => {
  const containerList = `${APP_CONTAINER_ID} kneura-web-teach-server-pm2\n${MEDIA_CONTAINER_ID} media`;

  const result = runBash(`container_name ${APP_CONTAINER_ID} ${shellQuote(containerList)}`);

  assert.equal(result.stdout, 'kneura-web-teach-server-pm2');
});

test('container_name with an unlisted id prints the short id', () => {
  const result = runBash(`container_name ${UNKNOWN_CONTAINER_ID} ${shellQuote(`${APP_CONTAINER_ID} kneura`)}`);

  assert.equal(result.stdout, 'container:cccccccccccc');
});

// --- helpers: /proc parsers -------------------------------------------------------------------

test('tcp_listen_counters prints ListenDrops then ListenOverflows', () => {
  const directory = temporaryDirectory();
  writeTree(directory, { netstat: netstat({ drops: 7, overflows: 5 }) });

  const result = runBash(`tcp_listen_counters ${shellQuote(path.join(directory, 'netstat'))}`);

  assert.equal(result.stdout, '7 5');
});

test('net_rx_softirqs sums NET_RX across every CPU', () => {
  const directory = temporaryDirectory();
  writeTree(directory, { softirqs: softirqs([100, 250]) });

  const result = runBash(`net_rx_softirqs ${shellQuote(path.join(directory, 'softirqs'))}`);

  assert.equal(result.stdout, '350');
});

test('fork_total prints the processes counter', () => {
  const directory = temporaryDirectory();
  writeTree(directory, { stat: procStat({ user: 1, system: 1, idle: 1, iowait: 0, softirq: 0, forks: 4242 }) });

  const result = runBash(`fork_total ${shellQuote(path.join(directory, 'stat'))}`);

  assert.equal(result.stdout, '4242');
});

test('cpu_jiffies prints user+nice, system, idle, iowait and softirq', () => {
  const directory = temporaryDirectory();
  writeTree(directory, { stat: 'cpu  100 5 200 1000 10 0 20 0 0 0\n' });

  const result = runBash(`cpu_jiffies ${shellQuote(path.join(directory, 'stat'))}`);

  assert.equal(result.stdout, '105 200 1000 10 20');
});

test('process_cpu_ticks sums utime and stime even when the command name has spaces', () => {
  const directory = temporaryDirectory();
  writeTree(directory, { stat: processStat(30, 12) });

  const result = runBash(`process_cpu_ticks ${shellQuote(path.join(directory, 'stat'))}`);

  assert.equal(result.stdout, '42');
});

test('process_cpu_ticks for a process that has exited prints 0', () => {
  const missingFile = path.join(temporaryDirectory(), 'gone', 'stat');

  const result = runBash(`process_cpu_ticks ${shellQuote(missingFile)}`);

  assert.equal(result.stdout, '0');
});

// --- helpers: rates and formatting ------------------------------------------------------------

test('per_second divides the counter delta by the window', () => {
  const result = runBash('per_second 100 96100 10');

  assert.equal(result.stdout, '9600');
});

test('per_second with a fractional window divides by it', () => {
  const result = runBash('per_second 0 25 2.5');

  assert.equal(result.stdout, '10');
});

test('uptime_seconds prints seconds since boot', () => {
  const directory = temporaryDirectory();
  writeTree(directory, { uptime: '8306361.42 41234567.89\n' });

  const result = runBash(`uptime_seconds ${shellQuote(path.join(directory, 'uptime'))}`);

  assert.equal(result.stdout, '8306361.42');
});

test('elapsed_seconds prints the measured window', () => {
  const result = runBash('elapsed_seconds 1000.00 1012.34 10');

  assert.equal(result.stdout, '12.3');
});

test('elapsed_seconds without a measurement falls back to the planned window', () => {
  const result = runBash("elapsed_seconds '' '' 10");

  assert.equal(result.stdout, '10.0');
});

test('elapsed_seconds with a non-positive measurement falls back to the planned window', () => {
  const result = runBash('elapsed_seconds 1000.00 1000.00 10');

  assert.equal(result.stdout, '10.0');
});

test('cpu_split prints each share of the elapsed CPU time', () => {
  const result = runBash(`cpu_split '100 200 1000 10 20' '300 900 1000 10 120'`);

  assert.equal(result.stdout.trim(), 'cpu split: user 20%  system 70%  idle 0%  iowait 0%  softirq 10%');
});

test('cpu_split with no elapsed CPU time says so instead of dividing by zero', () => {
  const result = runBash(`cpu_split '1 1 1 1 1' '1 1 1 1 1'`);

  assert.equal(result.stdout.trim(), 'cpu split: no CPU time elapsed');
});

test('cores_used converts a tick delta into cores', () => {
  const result = runBash('cores_used 2000 2100 100 10');

  assert.equal(result.stdout, '0.10');
});

test('vmstat_rates prints a per-second rate for each counter', () => {
  const result = runBash(`vmstat_rates 'pgscan_kswapd 0
allocstall_normal 0' 'pgscan_kswapd 5000
allocstall_normal 30' 10`);

  assert.deepEqual(result.stdout.trim().split('\n').map((line) => line.replace(/\s+/g, ' ')), [
    'pgscan_kswapd 500 /s',
    'allocstall_normal 3 /s',
  ]);
});

test('zombie_parents lists parents by zombie count, largest first, up to the limit', () => {
  const psText = ' 276876 Z\n 276876 Z\n 3074198 Z\n 1 Ss\n 4071630 Z\n 4071630 Z\n 4071630 Z';

  const result = runBash(`zombie_parents ${shellQuote(psText)} 2`);

  assert.deepEqual(result.stdout.trim().split('\n'), ['3 4071630', '2 276876']);
});

test('top_process_rows uses only the last top sample', () => {
  const result = runBash(`top_process_rows ${shellQuote(TOP_OUTPUT)} 15`);

  assert.deepEqual(result.stdout.trim().split('\n'), [
    `${APP_PID} 91.2 1.4 node`,
    `${DOCKERD_PID} 12.5 1.6 dockerd`,
  ]);
});

test('top_process_rows stops at the limit', () => {
  const result = runBash(`top_process_rows ${shellQuote(TOP_OUTPUT)} 1`);

  assert.deepEqual(result.stdout.trim().split('\n'), [`${APP_PID} 91.2 1.4 node`]);
});

test('top_summary prints the header of the last top sample', () => {
  const result = runBash(`top_summary ${shellQuote(TOP_OUTPUT)}`);

  assert.match(result.stdout, /^top - 05:50:06 .*\n.*\n%Cpu\(s\): 22.0 us, 75.0 sy/);
});

// --- end to end -------------------------------------------------------------------------------

test('a run exits 0', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.equal(result.status, EXIT_OK, result.stderr);
});

test('a run reports the CPU split over the sample window', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, /cpu split: user 20%  system 70%  idle 0%  iowait 0%  softirq 10%/);
});

test('a run reports forks per second', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, /forks\/s: 6\n/);
});

test('a run reports TCP listen drops and overflows per second', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, /tcp ListenDrops\/s: 9600   ListenOverflows\/s: 10/);
});

test('a run reports NET_RX softirqs per second', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, /NET_RX softirqs\/s: 30000/);
});

test('a run reports dockerd current cores', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, /dockerd cores: 0\.10/);
});

test('a run reports kernel memory reclaim rates', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, /allocstall_normal\s+3 \/s/);
});

test('a run reports connection state counts on the front-door port', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, /CONNECTIONS on :6080[\s\S]*3 ESTAB\n\s+1 SYN-RECV/);
});

test('a run maps a top process to its container name', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, new RegExp(`${APP_PID}\\s+91\\.2\\s+1\\.4\\s+kneura-web-teach-server-pm2\\s+node`));
});

test('a run maps a host process to host', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, new RegExp(`${DOCKERD_PID}\\s+12\\.5\\s+1\\.6\\s+host\\s+dockerd`));
});

test('a run maps the biggest zombie parent to its container', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, new RegExp(`3 zombies  parent ${ZOMBIE_PARENT_PID}\\s+navneet-media-converter-server`));
});

test('a run reports the total zombie count', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  assert.match(result.stdout, /total zombies: 4\n/);
});

test('a run saves the report to one log file under ./logs of the working directory', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run();

  assert.deepEqual(listFiles(scriptRun.workDir).map((name) => name.replace(/\d{8}T\d{6}Z/, 'TIMESTAMP')), [
    path.join('logs', 'host-cpu-TIMESTAMP.log'),
  ]);
});

test('the log file holds the same report that was printed', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run();

  const [logName] = listFiles(scriptRun.workDir);
  assert.ok(result.stdout.startsWith(fs.readFileSync(path.join(scriptRun.workDir, logName), 'utf8')));
});

test('a run with HOST_CPU_DIAG_LOG_DIR writes the log there', () => {
  const scriptRun = new ScriptRun();
  const logDir = path.join(scriptRun.root, 'custom-logs');

  scriptRun.run([], { HOST_CPU_DIAG_LOG_DIR: logDir });

  assert.equal(listFiles(logDir).length, 1);
});

test('a run only ever calls docker ps', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run();

  assert.deepEqual(scriptRun.dockerCommands(), ['ps --no-trunc --format {{.ID}} {{.Names}}']);
});

test('a run leaves the script folder unchanged', () => {
  const scriptRun = new ScriptRun();
  const before = listFiles(scriptRun.copyDir);

  scriptRun.run();

  assert.deepEqual(listFiles(scriptRun.copyDir), before);
});

test('a run without a readable /proc exits with the configuration error code', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run([], { HOST_CPU_DIAG_PROC_ROOT: path.join(scriptRun.root, 'no-proc') });

  assert.equal(result.status, EXIT_ERROR);
});

test('a run with an invalid sample window writes no log', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run([], { HOST_CPU_DIAG_SAMPLE_SECONDS: '0' });

  assert.deepEqual(listFiles(scriptRun.workDir), []);
});

test('a run with an unknown argument exits with the configuration error code', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--force']);

  assert.equal(result.status, EXIT_ERROR);
});

test('--help prints the usage and exits 0', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run(['--help']);

  assert.match(result.stdout, /READ-ONLY on the host/);
});

// --- end to end: light on a loaded host ------------------------------------------------------

test('a run lowers its own CPU priority to nice 19', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run();

  assert.match(scriptRun.priorityCommands().join('\n'), /^renice -n 19 -p \d+$/m);
});

test('a run lowers its own I/O priority to best-effort level 7', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run();

  assert.match(scriptRun.priorityCommands().join('\n'), /^ionice -c 2 -n 7 -p \d+$/m);
});

test('a run while another run holds the lock exits busy', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run([], { FAKE_FLOCK_BUSY: '1' });

  assert.equal(result.status, EXIT_BUSY);
});

test('a run while another run holds the lock writes no log', () => {
  const scriptRun = new ScriptRun();

  scriptRun.run([], { FAKE_FLOCK_BUSY: '1' });

  assert.deepEqual(listFiles(scriptRun.workDir), []);
});

test('a run whose sample window ran long divides rates by the measured window', () => {
  const scriptRun = new ScriptRun({ elapsedSeconds: SLOW_WINDOW_SECONDS });

  const result = scriptRun.run();

  assert.match(result.stdout, /forks\/s: 3\n/);
});

test('a run whose sample window ran long reports the measured window', () => {
  const scriptRun = new ScriptRun({ elapsedSeconds: SLOW_WINDOW_SECONDS });

  const result = scriptRun.run();

  assert.match(result.stdout, /RATES over 20\.0s \(measured; planned 10s\)/);
});

test('a run with a hanging ps finishes within the command timeout', () => {
  const scriptRun = new ScriptRun();
  const startedAt = Date.now();

  scriptRun.run([], { FAKE_PS_HANG: '1', HOST_CPU_DIAG_COMMAND_TIMEOUT_SECONDS: SHORT_COMMAND_TIMEOUT });

  assert.ok(Date.now() - startedAt < HANG_TEST_BUDGET_MS, `took ${Date.now() - startedAt} ms`);
});

test('a run with a hanging ps reports the timeout instead of the parent command', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run([], { FAKE_PS_HANG: '1', HOST_CPU_DIAG_COMMAND_TIMEOUT_SECONDS: SHORT_COMMAND_TIMEOUT });

  assert.match(result.stdout, /parent 276876\s+navneet-media-converter-server\s+\(ps timed out or process gone\)/);
});

test('a run whose top fails says so and still reports zombie parents', () => {
  const scriptRun = new ScriptRun();

  const result = scriptRun.run([], { FAKE_TOP_FAIL: '1' });

  assert.match(result.stdout, /\(top timed out or failed\)[\s\S]*total zombies: 4/);
});
