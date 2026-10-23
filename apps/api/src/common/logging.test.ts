import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { isProbe, loggerParams, requestLevel, SEVERITY, traceField } from './logging.js';

const TRACE = '105445aa7843bc8bf206b12000100000';

describe('traceField', () => {
  it('builds the field Cloud Logging correlates on, from the header Cloud Run sends', () => {
    expect(traceField(`${TRACE}/1;o=1`, 'my-proj')).toBe(`projects/my-proj/traces/${TRACE}`);
    expect(traceField(TRACE, 'my-proj')).toBe(`projects/my-proj/traces/${TRACE}`);
  });

  it.each([
    ['no header', undefined, 'p'],
    ['a header that is not a string', ['x'], 'p'],
    ['no project', `${TRACE}/1`, undefined],
    ['an id that is not 32 hex digits', 'abc/1', 'p'],
    ['an id with something else in it', `${TRACE.slice(0, 31)}Z/1`, 'p'],
  ])('is nothing for %s', (_name, header, project) => {
    expect(traceField(header, project)).toBeNull();
  });
});

describe('isProbe', () => {
  it('knows the two health paths, exactly', () => {
    expect(isProbe({ url: '/health' })).toBe(true);
    expect(isProbe({ url: '/health/live' })).toBe(true);
    expect(isProbe({ url: '/health/other' })).toBe(false);
    expect(isProbe({ url: '/runs' })).toBe(false);
    expect(isProbe({})).toBe(false);
  });
});

describe('SEVERITY', () => {
  it('maps every pino level to one Cloud Logging knows', () => {
    expect(SEVERITY).toEqual({
      trace: 'DEBUG',
      debug: 'DEBUG',
      info: 'INFO',
      warn: 'WARNING',
      error: 'ERROR',
      fatal: 'CRITICAL',
    });
  });
});

/** What pino writes, as lines, for options built by loggerParams. */
function lines(format: 'json' | 'gcp', write: (log: ReturnType<typeof pino>) => void): string[] {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      chunks.push(chunk.toString('utf8'));
      done();
    },
  });
  const options = loggerParams({
    LOG_FORMAT: format,
    LOG_LEVEL: 'info',
    GCP_PROJECT_ID: 'p',
  }).pinoHttp;
  write(pino(options as object, sink));
  return chunks.join('').trim().split('\n');
}

describe('loggerParams', () => {
  it('gcp: one JSON line with severity, message and an ISO time, and none of pino’s own fields', () => {
    const [line] = lines('gcp', (log) => log.warn({ runId: 'r1' }, 'the model is slow'));
    const entry = JSON.parse(line ?? '{}') as Record<string, unknown>;
    expect(entry['severity']).toBe('WARNING');
    expect(entry['message']).toBe('the model is slow');
    expect(entry['runId']).toBe('r1');
    expect(entry['time']).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    for (const own of ['level', 'msg', 'pid', 'hostname']) expect(entry).not.toHaveProperty(own);
  });

  it('gcp: an error is ERROR, not a number', () => {
    const [line] = lines('gcp', (log) => log.error('boom'));
    expect((JSON.parse(line ?? '{}') as { severity: string }).severity).toBe('ERROR');
  });

  it('json: keeps pino’s default shape', () => {
    const [line] = lines('json', (log) => log.info('hello'));
    const entry = JSON.parse(line ?? '{}') as Record<string, unknown>;
    expect(entry['msg']).toBe('hello');
    expect(entry['level']).toBe(30);
  });

  it('honours the level, and never logs a probe', () => {
    const params = loggerParams({
      LOG_FORMAT: 'gcp',
      LOG_LEVEL: 'warn',
      GCP_PROJECT_ID: undefined,
    });
    expect((params.pinoHttp as { level: string }).level).toBe('warn');
    const ignore = (params.pinoHttp as { autoLogging: { ignore: (r: { url: string }) => boolean } })
      .autoLogging.ignore;
    expect(ignore({ url: '/health/live' })).toBe(true);
  });

  it('gcp: adds the trace to a request’s lines, and a request is only its method and path', () => {
    const http = loggerParams({ LOG_FORMAT: 'gcp', LOG_LEVEL: 'info', GCP_PROJECT_ID: 'p' })
      .pinoHttp as {
      customProps: (req: object) => Record<string, string>;
      serializers: { req: (r: object) => object };
    };
    expect(http.customProps({ headers: { 'x-cloud-trace-context': `${TRACE}/1;o=1` } })).toEqual({
      'logging.googleapis.com/trace': `projects/p/traces/${TRACE}`,
    });
    expect(http.customProps({ headers: {} })).toEqual({});
    expect(
      http.serializers.req({
        id: 7,
        method: 'POST',
        url: '/demo/runs',
        headers: { cookie: 'secret' },
      }),
    ).toEqual({ id: 7, method: 'POST', url: '/demo/runs' });
  });
});

describe('requestLevel', () => {
  it.each([
    [200, undefined, 'info'],
    [302, undefined, 'info'],
    [403, undefined, 'warn'],
    [429, undefined, 'warn'],
    [500, undefined, 'error'],
    [503, undefined, 'error'],
    [200, new Error('x'), 'error'],
  ] as const)('status %i with error %s is %s', (statusCode, error, level) => {
    expect(requestLevel({ statusCode }, error)).toBe(level);
  });
});
