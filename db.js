/**
 * @file db.js
 * Conector de PostgreSQL con soporte dual para DATABASE_URL o credenciales individuales.
 */
const { Pool } = require('pg');

const config = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST || 'automat_postgres-db',
      port: Number(process.env.DB_PORT) || 5432,
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'automat'
    };

if (process.env.NODE_ENV === 'production') {
  config.ssl = { rejectUnauthorized: false };
}

const pool = new Pool(config);

module.exports = {
  query: (text, params) => pool.query(text, params)
};
