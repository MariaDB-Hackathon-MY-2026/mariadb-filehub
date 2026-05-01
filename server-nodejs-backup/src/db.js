const mariadb = require('mariadb');

const pool = mariadb.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'FILEHUB',
  connectionLimit: 10,
  // Return JS numbers for BIGINT instead of BigInt
  bigIntAsNumber: true,
});

async function query(sql, params) {
  const conn = await pool.getConnection();
  try {
    return await conn.query(sql, params);
  } finally {
    conn.release();
  }
}

module.exports = { query };
