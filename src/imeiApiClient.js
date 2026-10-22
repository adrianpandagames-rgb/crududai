import https from "https";
import { maskApiKeyInUrl } from "./loggingUtils.js";
import pool from "./db.js";

const checkImeiAccountApi = (apiKey) => {
  const host = "dash.imei.info";
  const path = `/api/account/account/?API_KEY=${encodeURIComponent(apiKey)}`;

  return new Promise((resolve) => {
    const options = {
      hostname: host,
      path,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'nodejs-imei-client/1.0'
      },
      timeout: 10000,
    };

    console.log('Checking IMEI account API at', maskApiKeyInUrl(`https://${host}${path}`));

    const req = https.request(options, (response) => {
      const { statusCode } = response;
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        console.log(`IMEI account API response status: ${statusCode}`);
        resolve(statusCode === 200);
      });
    });

    req.on('error', (err) => {
      console.log('Error checking IMEI account API:', err && err.message);
      resolve(false);
    });

    req.on('timeout', () => {
      console.log('IMEI account API request timed out');
      req.destroy();
      resolve(false);
    });

    req.end();
  });
};

const getStoredImeiMetadata = async (imei) => {
  try {
    const [rows] = await pool.query(
      `SELECT brand_name, modelo
       FROM imei
       WHERE imei = ?
       ORDER BY idImei DESC
       LIMIT 1`,
      [imei],
    );

    const record = rows && rows[0];
    if (!record) {
      return null;
    }

    if (record.brand_name || record.modelo) {
      return {
        brand_name: record.brand_name || null,
        modelo: record.modelo || null,
        raw: null,
        available: true,
      };
    }

    return null;
  } catch (error) {
    console.log('Error reading stored IMEI metadata:', error && error.message ? error.message : error);
    return null;
  }
};

const fetchImeiMetadata = async (imei) => {
  const storedMetadata = await getStoredImeiMetadata(imei);
  if (storedMetadata) {
    console.log('Reusing stored IMEI metadata for', imei, 'instead of querying the API.');
    return storedMetadata;
  }

  const apiKey = process.env.IMEI_API_KEY;
  const serviceId = process.env.IMEI_SERVICE_ID || "0";
  const host = "dash.imei.info";

  if (!apiKey) {
    console.log('Skipping IMEI metadata lookup because IMEI_API_KEY is not configured.');
    return { brand_name: null, modelo: null, raw: null, available: false };
  }

  const path = `/api/check/${serviceId}/?API_KEY=${encodeURIComponent(apiKey)}&imei=${encodeURIComponent(imei)}`;

  const makeAttempt = (attemptsLeft) => {
    return new Promise((resolve) => {
      const options = {
        hostname: host,
        path,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'nodejs-imei-client/1.0'
        },
        timeout: 10000,
      };

      console.log('Fetching IMEI metadata from', maskApiKeyInUrl(`https://${host}${path}`), 'attemptsLeft=', attemptsLeft);

      const req = https.request(options, (response) => {
        const { statusCode } = response;
        let data = '';
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          console.log(`IMEI metadata response status: ${statusCode}, length: ${data.length}`);
          console.log('IMEI metadata raw body (truncated 200 chars):', data && data.toString().slice(0, 200));
          try {
            const parsed = JSON.parse(data || '{}');
            console.log('IMEI metadata raw parsed:', parsed);
            const brandName = (parsed && typeof parsed.brand_name !== 'undefined') ? parsed.brand_name : (parsed?.result && typeof parsed.result.brand_name !== 'undefined' ? parsed.result.brand_name : null);
            const modelo = (parsed && typeof parsed.model !== 'undefined') ? parsed.model : (parsed?.result && typeof parsed.result.model !== 'undefined' ? parsed.result.model : null);
            resolve({ brand_name: brandName, modelo, raw: data });
          } catch (error) {
            console.log('Error parsing IMEI metadata JSON', error);
            resolve({ brand_name: null, modelo: null, raw: data });
          }
        });
      });

      req.on('error', (err) => {
        console.log('Error fetching IMEI metadata:', err && err.message);
        const isTimeoutLike = err && (err.code === 'ETIMEDOUT' || (err.message && err.message.toLowerCase().includes('timeout')));
        if (attemptsLeft > 0 && isTimeoutLike) {
          console.log('Retrying IMEI metadata fetch due to timeout/error, attempts left:', attemptsLeft - 1);
          setTimeout(() => makeAttempt(attemptsLeft - 1).then(resolve), 300);
        } else {
          resolve({ brand_name: null, modelo: null, raw: null });
        }
      });

      req.on('timeout', () => {
        console.log('IMEI metadata request timed out');
        req.destroy();
        if (attemptsLeft > 0) {
          console.log('Retrying IMEI metadata fetch after timeout, attempts left:', attemptsLeft - 1);
          setTimeout(() => makeAttempt(attemptsLeft - 1).then(resolve), 300);
        } else {
          resolve({ brand_name: null, modelo: null, raw: null });
        }
      });

      req.end();
    });
  };

  return checkImeiAccountApi(apiKey).then((accountApiOk) => {
    if (!accountApiOk) {
      console.log('Skipping IMEI metadata lookup because the account endpoint did not return HTTP 200');
      return { brand_name: null, modelo: null, raw: null, available: false };
    }

    // allow one retry (attemptsLeft = 1 => up to 2 attempts)
    return makeAttempt(1);
  });
};

export { fetchImeiMetadata };
