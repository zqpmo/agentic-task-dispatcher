// Structured JSON logger for the deterministic task dispatcher
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { LogLevel } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = resolve(__dirname, '..', 'logs');

function ensureLogDir(): boolean {
  try {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }
    return true;
  } catch {
    return false;
  }
}

export class Logger {
  private level: LogLevel;
  private logFile: string;

  constructor(level: LogLevel = LogLevel.INFO, logFile: string = 'controller.log') {
    this.level = level;
    this.logFile = logFile;
    ensureLogDir();
  }

  log(level: LogLevel, message: string, data?: any) {
    if (level < this.level) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level: ['DEBUG', 'INFO', 'WARN', 'ERROR'][level],
      message,
      ...data,
    };

    const line = JSON.stringify(entry) + '\n';

    if (level >= LogLevel.WARN) {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }

    try {
      ensureLogDir();
      appendFileSync(resolve(LOG_DIR, this.logFile), line);
    } catch (e) {
      // Terminal already has the line; file failure must not crash the run.
      process.stderr.write(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'WARN',
          message: 'log_file_write_failed',
          error: String(e),
        }) + '\n'
      );
    }
  }

  debug(msg: string, data?: any) { this.log(LogLevel.DEBUG, msg, data); }
  info(msg: string, data?: any) { this.log(LogLevel.INFO, msg, data); }
  warn(msg: string, data?: any) { this.log(LogLevel.WARN, msg, data); }
  error(msg: string, data?: any) { this.log(LogLevel.ERROR, msg, data); }
}

export function createLogger(level?: LogLevel, logFile?: string): Logger {
  return new Logger(level, logFile);
}
