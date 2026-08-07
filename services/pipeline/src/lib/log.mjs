/** Structured stderr logging so container logs stay grep/parse-able. */
export function log(level, msg, fields = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

export const logInfo = (msg, fields) => log('info', msg, fields);
export const logWarn = (msg, fields) => log('warn', msg, fields);
export const logError = (msg, fields) => log('error', msg, fields);
