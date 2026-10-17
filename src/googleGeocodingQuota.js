export const GOOGLE_GEOCODING_REQUEST_LIMIT = 8000;

const initializedPools = new WeakMap();

async function ensureQuotaTable(pool) {
  let initialization = initializedPools.get(pool);
  if (!initialization) {
    initialization = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS google_geocoding_quota (
        id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
        request_count INT UNSIGNED NOT NULL DEFAULT 0,
        is_blocked TINYINT(1) NOT NULL DEFAULT 0,
        blocked_at DATETIME NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
      await pool.execute('INSERT IGNORE INTO google_geocoding_quota (id) VALUES (1)');
    })();
    initializedPools.set(pool, initialization);
    initialization.catch(() => initializedPools.delete(pool));
  }
  await initialization;
}

export async function getGoogleGeocodingQuota(pool) {
  await ensureQuotaTable(pool);
  const [rows] = await pool.execute(
    'SELECT request_count AS requestCount, is_blocked AS isBlocked FROM google_geocoding_quota WHERE id = 1',
  );
  if (rows.length !== 1) throw new Error('No fue posible leer el contador de Google Geocoding.');
  return {
    requestCount: Number(rows[0].requestCount),
    isBlocked: Number(rows[0].isBlocked) === 1,
    limit: GOOGLE_GEOCODING_REQUEST_LIMIT,
  };
}

export async function reserveGoogleGeocodingRequest(pool) {
  await ensureQuotaTable(pool);
  const [result] = await pool.execute(
    `UPDATE google_geocoding_quota
     SET is_blocked = request_count >= ?,
         blocked_at = IF(request_count >= ?, COALESCE(blocked_at, CURRENT_TIMESTAMP), blocked_at),
         request_count = request_count + 1
     WHERE id = 1 AND is_blocked = 0 AND request_count < ?`,
    [GOOGLE_GEOCODING_REQUEST_LIMIT - 1, GOOGLE_GEOCODING_REQUEST_LIMIT - 1, GOOGLE_GEOCODING_REQUEST_LIMIT],
  );
  const quota = await getGoogleGeocodingQuota(pool);
  if (result.affectedRows !== 1) {
    const error = new Error('Se alcanzó el límite de 8000 consultas a Google Geocoding. El servicio está bloqueado hasta que un administrador reinicie el contador.');
    error.code = 'GOOGLE_GEOCODING_QUOTA_BLOCKED';
    throw error;
  }
  if (quota.requestCount === GOOGLE_GEOCODING_REQUEST_LIMIT) {
    console.error('[Google Geocoding] ALARMA: se alcanzó el límite de 8000 consultas; se bloquearon nuevas solicitudes.');
  }
}

export async function resetGoogleGeocodingQuota(pool) {
  await ensureQuotaTable(pool);
  await pool.execute(
    `UPDATE google_geocoding_quota
     SET request_count = 0, is_blocked = 0, blocked_at = NULL
     WHERE id = 1`,
  );
  return getGoogleGeocodingQuota(pool);
}
