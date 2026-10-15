/**
 * Application configuration.
 *
 * Only values that are actually injected through `ConfigService` live here.
 * Anything read straight from `process.env` at the point of use (the database
 * URL, the HTTP port, the rate-limit ceilings) is deliberately not duplicated,
 * so each setting has a single source.
 */
export default () => ({
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  session: {
    ttlHours: parseInt(process.env['SESSION_TTL_HOURS'] ?? '12', 10),
  },
  frontend: {
    url: process.env['FRONTEND_URL'] ?? 'http://localhost:5173',
  },
  redis: {
    host: process.env['REDIS_HOST'] ?? '127.0.0.1',
    port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
  },
});
