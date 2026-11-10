// Structured JSON logger for v3 Cron Controller
import { writeFileSync, appendFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { LogLevel } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = resolve(__dirname, '..', 'logs');

export class Logger {
  private level: LogLevel;
  private logFile: string;

  constructor(level: LogLevel = LogLevel.INFO, logFile: string = 'controller.log') {
    this.level = level;
    this.logFile = logFile;
    if (!existsSync(LOG_DIR)) {
      // skip mkdir in pure function context
    }
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
      appendFileSync(resolve(LOG_DIR, this.logFile), line);
    } catch {
      // silent fail for log writes
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
