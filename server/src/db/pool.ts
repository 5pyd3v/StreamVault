import mysql from 'mysql2/promise';

// A single shared connection pool for the whole process. mysql2's pool
// handles reconnects/queueing internally, so callers just `await pool.query(...)`.
export const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'streamvault',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE) || 10,
  queueLimit: 0,
  dateStrings: false,
});

/** Verifies the pool can actually reach MySQL -- call once at startup before listen(). */
export async function testConnection(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT 1');
  } finally {
    conn.release();
  }
}
