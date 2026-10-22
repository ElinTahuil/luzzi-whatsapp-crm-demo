// ============================================================
//  db.js — Pool de conexiones MySQL
// ============================================================
const mysql = require('mysql2/promise');
const { config } = require('./config');

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: 'Z', // guardamos en UTC; el front formatea a hora local
  charset: 'utf8mb4',
  enableKeepAlive: true,
});

function compactSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

async function query(sql, params = []) {
  // Meta-indexing operativo: medimos cada consulta para detectar rápido
  // qué query empieza a sufrir cuando crecen usuarios, contactos o mensajes.
  const started = Date.now();
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } finally {
    const took = Date.now() - started;
    const limit = Number(config.performance && config.performance.slowQueryMs) || 0;
    if (limit && took >= limit) {
      console.warn(`[slow-sql] ${took}ms ${compactSql(sql)}`);
    }
  }
}

async function testConnection() {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.ping();
    console.log('✅ MySQL conectado correctamente');
    return true;
  } catch (err) {
    console.error('❌ Error conectando a MySQL:', err.message);
    return false;
  } finally {
    if (conn) conn.release(); // <- importante: liberar la conexión (el original no lo hacía)
  }
}

// ============================================================
//  withTransaction(fn) — ejecuta varias queries como una sola unidad
//  atómica (ACID). Hasta v2.66.4 TODO el proyecto usaba únicamente
//  query()/pool.execute(), que ejecuta cada sentencia SUELTA: si una
//  operación de varios pasos (ej. crear un negocio + su configuración +
//  su menú + su usuario) fallaba a mitad de camino, quedaba el tenant
//  "a medio crear" en la base, sin ninguna forma de deshacer lo ya
//  insertado. Este helper cierra ese hueco.
//
//  Uso:
//    await withTransaction(async (tx) => {
//      const r = await tx.query('INSERT INTO ...', [...]);
//      await tx.query('INSERT INTO ... VALUES (?)', [r.insertId]);
//      // si CUALQUIER query de acá adentro tira una excepción, se hace
//      // ROLLBACK automático y no queda ningún registro a medias.
//    });
//
//  `fn` recibe un objeto `tx` con su propio `query(sql, params)` que
//  corre SIEMPRE sobre la MISMA conexión (necesario: una transacción de
//  MySQL vive atada a una conexión particular del pool, no se puede
//  repartir entre varias). Se hace COMMIT si `fn` resuelve sin errores,
//  y ROLLBACK si tira cualquier excepción (el error se re-lanza para que
//  el endpoint que llamó pueda loguearlo/responder 500 como ya hacía).
//  La conexión SIEMPRE se libera al pool al final, haya salido bien o mal.
// ============================================================
async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const tx = {
      // Mismo "shape" que query() de más arriba, para que el código que
      // ya sabe usar `query(sql, params)` no tenga que aprender nada nuevo.
      query: async (sql, params = []) => {
        const [rows] = await conn.execute(sql, params);
        return rows;
      },
    };
    const result = await fn(tx);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      // Si ni el rollback funciona (ej. la conexión se cayó), lo dejamos
      // registrado igual: es un caso raro pero no queremos que se pierda
      // el error original silenciosamente.
      console.error('[db] falló el rollback tras un error:', rollbackErr.message);
    }
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { query, pool, testConnection, withTransaction };
