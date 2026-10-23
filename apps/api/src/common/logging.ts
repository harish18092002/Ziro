// Structured logs. `json` is pino's own shape. `gcp` is what Cloud Run's logging agent understands: one JSON
// object per line on stdout, with `severity` (not a numeric level), `message` (not `msg`), an RFC 3339
// `time`, and `logging.googleapis.com/trace` so a request's lines nest under its request log. Nothing here
// logs request bodies or headers: a request is its method, path, status and time.
import type { IncomingMessage } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { Env } from '../config/env.js';

export type LogSettings = Pick<Env, 'LOG_FORMAT' | 'LOG_LEVEL' | 'GCP_PROJECT_ID'>;

/** pino level names to Cloud Logging severities. */
export const SEVERITY: Readonly<Record<string, string>> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

/**
 * `projects/<project>/traces/<id>` from an `X-Cloud-Trace-Context: <id>/<span>;o=<flag>` header, or null when
 * there is no header, no project, or the id is not the 32 hex digits Google sends.
 */
export function traceField(header: unknown, project: string | undefined): string | null {
  if (project === undefined || typeof header !== 'string') return null;
  const id = header.split('/')[0] ?? '';
  return /^[0-9a-f]{32}$/i.test(id) ? `projects/${project}/traces/${id}` : null;
}

/** Health checks and probes would drown the log: one line per probe, every few seconds. */
export const isProbe = (req: Pick<IncomingMessage, 'url'>): boolean =>
  req.url === '/health' || req.url === '/health/live';

/** A request that failed on our side is an error; one we refused is a warning; the rest is information. */
export function requestLevel(
  res: { statusCode: number },
  error: Error | undefined,
): 'error' | 'warn' | 'info' {
  if (error !== undefined || res.statusCode >= 500) return 'error';
  return res.statusCode >= 400 ? 'warn' : 'info';
}

export function loggerParams(env: LogSettings): Params {
  const common = {
    level: env.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    autoLogging: { ignore: isProbe },
    customLogLevel: (_req: unknown, res: { statusCode: number }, error: Error | undefined) =>
      requestLevel(res, error),
  };
  if (env.LOG_FORMAT === 'json') return { pinoHttp: common };

  return {
    pinoHttp: {
      ...common,
      messageKey: 'message',
      base: null, // no pid or hostname: Cloud Run labels every line with its revision and instance
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      formatters: { level: (label: string) => ({ severity: SEVERITY[label] ?? 'DEFAULT' }) },
      // The request is logged as what it was, not as its headers.
      serializers: {
        req: (req: { id?: unknown; method?: string; url?: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      },
      customProps: (req: IncomingMessage) => {
        const trace = traceField(req.headers['x-cloud-trace-context'], env.GCP_PROJECT_ID);
        return trace === null ? {} : { 'logging.googleapis.com/trace': trace };
      },
    },
  };
}
