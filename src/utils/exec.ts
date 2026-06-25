import { execSync, type ChildProcess } from 'child_process';
import { Worker } from 'worker_threads';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnShellCommand } from './process.js';

export class ProofShotError extends Error {
  constructor(
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'ProofShotError';
  }
}

export interface AgentBrowserCommandOptions {
  configPath?: string;
  session?: string;
  timeoutMs?: number;
}

let defaultAgentBrowserOptions: Pick<AgentBrowserCommandOptions, 'configPath'> = {};

export function setAgentBrowserDefaults(
  options: Pick<AgentBrowserCommandOptions, 'configPath'>,
): void {
  defaultAgentBrowserOptions = { ...options };
}

function shellQuote(value: string): string {
  const escaped = value.replace(/'/g, "'\\''");
  return `'${escaped}'`;
}

export function buildAgentBrowserCommand(
  command: string,
  options: Pick<AgentBrowserCommandOptions, 'configPath' | 'session'> = {},
): string {
  const mergedOptions = {
    ...defaultAgentBrowserOptions,
    ...options,
  };
  const configFlag = mergedOptions.configPath ? ` --config ${shellQuote(mergedOptions.configPath)}` : '';
  const sessionFlag = mergedOptions.session ? ` --session ${shellQuote(mergedOptions.session)}` : '';
  return `agent-browser${configFlag}${sessionFlag} ${command}`;
}

// ESM Worker script that spawns agent-browser and signals via SharedArrayBuffer.
// Listening on 'exit' (not 'close') lets us return as soon as the Rust binary
// exits without waiting for the daemon to release the inherited pipe.
const WORKER_SCRIPT = `
import { workerData } from 'worker_threads';
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';

const signal = new Int32Array(workerData.sab);

const proc = spawn(workerData.command, [], {
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let stdout = '', stderr = '';
proc.stdout?.on('data', d => { stdout += d.toString(); });
proc.stderr?.on('data', d => { stderr += d.toString(); });

const timer = setTimeout(() => {
  try { proc.kill(); } catch {}
  writeFileSync(workerData.out, JSON.stringify({ stdout: stdout.trim(), stderr: '', code: null, timedOut: true }), 'utf-8');
  Atomics.store(signal, 0, 2);
  Atomics.notify(signal, 0);
}, workerData.timeoutMs);

proc.on('exit', code => {
  clearTimeout(timer);
  writeFileSync(workerData.out, JSON.stringify({ stdout: stdout.trim(), stderr: stderr.trim(), code }), 'utf-8');
  Atomics.store(signal, 0, code === 0 ? 1 : -1);
  Atomics.notify(signal, 0);
});
`;

interface WorkerResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut?: boolean;
}

/**
 * Run an agent-browser command, returning its stdout.
 *
 * The agent-browser Rust binary spawns a persistent Node.js daemon which
 * inherits the write-end of any stdout pipe, blocking execSync forever.
 * We work around this by spawning the command in a Worker thread that listens
 * for the 'exit' event (fires when the Rust binary exits, ~1-2s) rather than
 * waiting for pipes to close (daemon holds them open indefinitely).
 * Atomics.wait blocks the main thread synchronously until the Worker signals.
 */
export function ab(
  command: string,
  timeoutOrOptions: number | AgentBrowserCommandOptions = 90000,
): string {
  const options =
    typeof timeoutOrOptions === 'number'
      ? { timeoutMs: timeoutOrOptions }
      : timeoutOrOptions;
  const fullCommand = buildAgentBrowserCommand(command, options);
  const timeoutMs = options.timeoutMs ?? 90000;

  const sab = new SharedArrayBuffer(4);
  const signal = new Int32Array(sab);
  const id = Date.now();
  const outPath = join(tmpdir(), `ab-result-${id}.json`);
  const workerPath = join(tmpdir(), `ab-worker-${id}.mjs`);

  writeFileSync(workerPath, WORKER_SCRIPT, 'utf-8');

  const worker = new Worker(workerPath, {
    workerData: { command: fullCommand, sab, out: outPath, timeoutMs },
  });

  // Atomics.wait is allowed on the main thread in Node.js.
  // Wakes immediately when the Rust binary exits; never burns the full timeout.
  Atomics.wait(signal, 0, 0, timeoutMs + 5000);
  worker.terminate();

  try { unlinkSync(workerPath); } catch {}

  let result: WorkerResult;
  try {
    result = JSON.parse(readFileSync(outPath, 'utf-8')) as WorkerResult;
    try { unlinkSync(outPath); } catch {}
  } catch {
    throw new ProofShotError(`Browser command failed: ${fullCommand}\nWorker produced no output`);
  }

  if (result.code !== 0 && !result.stdout) {
    const msg = result.stderr || (result.timedOut ? 'Timed out' : `Exit code ${result.code}`);
    throw new ProofShotError(`Browser command failed: ${fullCommand}\n${msg}`);
  }

  return result.stdout;
}

export function exec(command: string, timeoutMs = 30000): string {
  try {
    return execSync(command, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error: any) {
    const stderr = error?.stderr?.toString?.() || '';
    throw new ProofShotError(`Command failed: ${command}\n${stderr}`, error);
  }
}

export function spawnBackground(
  command: string,
  cwd?: string,
): ChildProcess {
  const proc = spawnShellCommand(command, {
    cwd: cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  proc.unref();
  return proc;
}
