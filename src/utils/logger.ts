type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const currentLevel: LogLevel =
  (process.env.DEP_TRACER_LOG_LEVEL as LogLevel) || 'info';

function log(level: LogLevel, ...args: unknown[]): void {
  if (LEVELS[level] >= LEVELS[currentLevel]) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
    // Must use stderr — stdout is reserved for MCP stdio transport
    console.error(prefix, ...args);
  }
}

export const logger = {
  debug: (...args: unknown[]) => log('debug', ...args),
  info: (...args: unknown[]) => log('info', ...args),
  warn: (...args: unknown[]) => log('warn', ...args),
  error: (...args: unknown[]) => log('error', ...args),
};
