const NOOP = () => undefined;

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveLevel(): LogLevel {
  if (process.env.LOG_ONLY_ERRORS === 'true') {
    return 'error';
  }

  const raw = (process.env.LOG_LEVEL || '').toLowerCase() as LogLevel | '';
  return raw && raw in LEVEL_RANK ? (raw as LogLevel) : 'info';
}

export function configureLogging(): void {
  const level = resolveLevel();
  const rank = LEVEL_RANK[level];

  if (rank > LEVEL_RANK.debug) {
    console.debug = NOOP;
  }
  if (rank > LEVEL_RANK.info) {
    console.log = NOOP;
    console.info = NOOP;
  }
  if (rank > LEVEL_RANK.warn) {
    console.warn = NOOP;
  }
}

