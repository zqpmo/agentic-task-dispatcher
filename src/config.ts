import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AppConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, '..', 'config', 'config.json');

export function loadConfig(): AppConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as AppConfig;
  } catch (e) {
    console.error(`[CONFIG] Failed to load ${CONFIG_PATH}:`, e);
    process.exit(3);
  }
}

export function resolveConfigPath(name: string): string {
  return resolve(__dirname, '..', 'config', name);
}
