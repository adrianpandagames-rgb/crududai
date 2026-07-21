import pool from './db.js';
import https from 'https';

const IMEI_HOST = 'dash.imei.info';
const IMEI_SERVICE_ID = process.env.IMEI_SERVICE_ID || '0';
const IMEI_API_KEY = process.env.IMEI_API_KEY || '44b89972-2697-48c4-a618-e65237579e26';

export const shouldRetryImeiMetadata = (row) => {
  if (!row) {
    return false;
  }

  return row.brand_name == null || row.modelo == null;
};

export const getNextNoonRunDelay = (now = new Date()) => {
  const nextRun = new Date(now);
  nextRun.setHours(12, 0, 0, 0);

  if (nextRun <= now) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  return nextRun.getTime() - now.getTime();
};

const ensureImeiMetadataColumns = async () => {
  try {
    const [columns] = await pool.query('SHOW COLUMNS FROM imei LIKE ?', ['brand_name']);
    if (!columns.length) {
      await pool.query('ALTER TABLE imei ADD COLUMN brand_name VARCHAR(255) NULL');
    }

    const [modelColumns] = await pool.query('SHOW COLUMNS FROM imei LIKE ?', ['modelo']);
    if (!modelColumns.length) {
      await pool.query('ALTER TABLE imei ADD COLUMN modelo VARCHAR(255) NULL');
    }
  } catch (error) {
    if (error && error.code !== 'ER_DUP_FIELDNAME') {
      throw error;
    }
  }
};

const fetchImeiMetadata = async (imei) => {
  const path = `/api/check/${IMEI_SERVICE_ID}/?API_KEY=${encodeURIComponent(IMEI_API_KEY)}&imei=${encodeURIComponent(imei)}`;

  const makeAttempt = async (attemptsLeft) => {
    const response = await new Promise((resolve) => {
      const options = {
        hostname: IMEI_HOST,
        path,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'nodejs-imei-client/1.0',
        },
        timeout: 10000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data || '{}');
            const brandName = (parsed && typeof parsed.brand_name !== 'undefined') ? parsed.brand_name : (parsed?.result && typeof parsed.result.brand_name !== 'undefined' ? parsed.result.brand_name : null);
            const modelo = (parsed && typeof parsed.model !== 'undefined') ? parsed.model : (parsed?.result && typeof parsed.result.model !== 'undefined' ? parsed.result.model : null);
            resolve({ brand_name: brandName, modelo, raw: data });
          } catch (error) {
            resolve({ brand_name: null, modelo: null, raw: data });
          }
        });
      });

      req.on('error', () => resolve({ brand_name: null, modelo: null, raw: null }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ brand_name: null, modelo: null, raw: null });
      });

      req.end();
    });

    if (response.brand_name && response.modelo) {
      return response;
    }

    if (attemptsLeft > 0) {
      return makeAttempt(attemptsLeft - 1);
    }

    return response;
  };

  return makeAttempt(1);
};

export const refreshImeiMetadata = async () => {
  await ensureImeiMetadataColumns();

  const [rows] = await pool.query(
    'SELECT i.idImei, i.imei, i.brand_name, i.modelo FROM imei i WHERE i.brand_name IS NULL OR i.modelo IS NULL'
  );

  if (!rows.length) {
    console.log('=== JOB IMEI: no hay registros con brand_name o modelo en NULL ===');
    return { processed: 0, updated: 0 };
  }

  console.log(`=== JOB IMEI: registros pendientes por completar: ${rows.length} ===`);
  rows.forEach((row) => {
    console.log(`=== JOB IMEI: pendiente -> IMEI: ${row.imei} | brand_name: ${row.brand_name ?? 'NULL'} | modelo: ${row.modelo ?? 'NULL'} ===`);
  });

  let updated = 0;
  for (const row of rows) {
    const metadata = await fetchImeiMetadata(row.imei);
    if (metadata && (metadata.brand_name || metadata.modelo)) {
      await pool.query(
        'UPDATE imei SET brand_name = ?, modelo = ? WHERE idImei = ?',
        [metadata.brand_name ?? null, metadata.modelo ?? null, row.idImei]
      );
      updated += 1;
    }
  }

  return { processed: rows.length, updated };
};

export const startImeiMetadataDailyJob = (callback = () => {}) => {
  let timeoutId = null;

  console.log('=== JOB IMEI: programada la revisión diaria a las 12:00 ===');

  const scheduleNextRun = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    const delay = getNextNoonRunDelay();
    timeoutId = setTimeout(async () => {
      console.log('=== JOB IMEI: ejecutando revisión diaria ===');
      try {
        const result = await refreshImeiMetadata();
        console.log(`=== JOB IMEI: revisión diaria finalizada. Procesados: ${result.processed || 0}, actualizados: ${result.updated || 0} ===`);
        callback(result);
      } catch (error) {
        console.log(`=== JOB IMEI: error en la revisión diaria: ${error.message} ===`);
        callback({ error: error.message });
      } finally {
        scheduleNextRun();
      }
    }, delay);
  };

  scheduleNextRun();
  return () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  };
};
