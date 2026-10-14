export default () => ({
  port: parseInt(process.env['PORT'] ?? '3000', 10),
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  database: {
    url: process.env['DATABASE_URL'],
  },
  session: {
    cookieName: process.env['SESSION_COOKIE_NAME'] ?? 'hotel_pms_session',
    ttlHours: parseInt(process.env['SESSION_TTL_HOURS'] ?? '12', 10),
  },
  frontend: {
    url: process.env['FRONTEND_URL'] ?? 'http://localhost:5173',
  },
  jwt: {
    secret: process.env['JWT_SECRET'] ?? 'change-me-in-production',
    expiresIn: process.env['JWT_EXPIRES'] ?? '8h',
  },
});
