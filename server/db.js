const { Pool } = require('pg');

// A single pool per Node process. Keep max modest per instance — with N
// horizontally-scaled instances, total connections = N * PG_POOL_MAX, and
// that must stay under your Postgres server's max_connections.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.PG_POOL_MAX || '20', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  // A dropped idle client shouldn't crash the whole process.
  console.error('Unexpected Postgres pool error', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,
};
