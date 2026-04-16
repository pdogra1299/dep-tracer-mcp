import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { logger } from './logger.js';

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a child process and stream its stdout line-by-line via a callback.
 * Used by the Haskell hie-reader which outputs NDJSON.
 */
export async function spawnAndStreamLines(
  command: string,
  args: string[],
  onLine: (line: string) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', onLine);

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
    });

    child.on('close', (code) => {
      if (stderr.trim()) {
        logger.debug(`${command} stderr:`, stderr.trim());
      }
      resolve(code ?? 1);
    });
  });
}

/**
 * Run a command and capture all output.
 */
export async function exec(command: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
    });

    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
