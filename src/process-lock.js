import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const run = promisify(execFile);
const normalize = value => String(value).replaceAll('\\', '/').toLowerCase();

export function matchesWorker(processInfo, workerPath) {
  if (!processInfo) return false;
  if (!/^(?:node(?:\.exe)?|NTE Scrapper\.exe)$/i.test(processInfo.name || '')) return false;
  // If Windows withholds a Node process's command line, preserve its lock.
  if (!processInfo.commandLine) return true;
  return normalize(processInfo.commandLine).includes(normalize(workerPath));
}

export async function isSameWorker(pid, workerPath) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform !== 'win32') return true;
  try {
    const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; if ($p) { @{name=$p.Name; commandLine=$p.CommandLine} | ConvertTo-Json -Compress }`;
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 7000, maxBuffer: 32768 });
    return matchesWorker(stdout.trim() ? JSON.parse(stdout) : null, workerPath);
  } catch {
    // A failed identity query must never create a second worker.
    return true;
  }
}
