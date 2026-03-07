import fs from "node:fs";
import path from "node:path";

const LOGS_DIR = path.resolve("logs");

let stream: fs.WriteStream | null = null;

function ensureStream(): fs.WriteStream {
  if (!stream) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(LOGS_DIR, `${ts}.log`);
    stream = fs.createWriteStream(filePath, { flags: "a" });
  }
  return stream;
}

function formatLine(pid: number, label: string, message: string): string {
  const timestamp = new Date().toISOString().split("T")[1].slice(0, 8);
  return `  [pid:${pid}] [${timestamp}] [${label}] ${message}`;
}

export function log(label: string, message: string, pid?: number): void {
  const line = formatLine(pid ?? process.pid, label, message);
  console.log(line);
  ensureStream().write(line + "\n");
}

export function logError(label: string, message: string, pid?: number): void {
  const line = formatLine(pid ?? process.pid, label, message);
  console.error(line);
  ensureStream().write(line + "\n");
}

/** Write a raw line to both console and the log file */
export function logRaw(line: string): void {
  console.log(line);
  ensureStream().write(line + "\n");
}

export function closeLogger(): Promise<void> {
  return new Promise((resolve) => {
    if (stream) {
      stream.end(resolve);
      stream = null;
    } else {
      resolve();
    }
  });
}
