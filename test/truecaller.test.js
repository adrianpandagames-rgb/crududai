import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createTruecallerIntegration } from '../src/truecallerRouter.js';

const withServer = async (callback) => {
  const app = express();
  app.use(express.json());
  const integration = createTruecallerIntegration();
  app.use('/api/truecaller/callback', integration.callbackRouter);
  app.use('/api/truecaller', (req, res, next) => {
    const userId = req.get('x-test-user-id');
    if (!userId) return res.sendStatus(401);
    req.session = { userId };
    return next();
  });
  app.use('/api/truecaller', integration.userRouter);

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  try {
    await callback(server);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
};

const request = (server, method, pathname, userId, body) => new Promise((resolve, reject) => {
  const payload = body ? JSON.stringify(body) : '';
  const httpRequest = http.request({
    host: '127.0.0.1',
    port: server.address().port,
    method,
    path: pathname,
    headers: {
      ...(userId ? { 'x-test-user-id': userId } : {}),
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
    },
  }, (response) => {
    let content = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { content += chunk; });
    response.on('end', () => {
      let json = null;
      if (content && response.headers['content-type']?.includes('application/json')) {
        try {
          json = JSON.parse(content);
        } catch {
          return reject(new Error('Response was not valid JSON.'));
        }
      }
      return resolve({ status: response.statusCode, body: json });
    });
  });
  httpRequest.once('error', reject);
  if (payload) httpRequest.write(payload);
  httpRequest.end();
});

const configureTruecaller = () => {
  process.env.TRUECALLER_APP_KEY = 'test-app-key';
  process.env.TRUECALLER_APP_NAME = 'Test App';
  process.env.TRUECALLER_PRIVACY_URL = 'https://app.example.test/privacy';
  process.env.TRUECALLER_TERMS_URL = 'https://app.example.test/terms';
};

test('Truecaller profile callback is scoped to the initiating user and returns a minimal profile', async (t) => {
  const oldEnvironment = {
    appKey: process.env.TRUECALLER_APP_KEY,
    appName: process.env.TRUECALLER_APP_NAME,
    privacyUrl: process.env.TRUECALLER_PRIVACY_URL,
    termsUrl: process.env.TRUECALLER_TERMS_URL,
  };
  t.after(() => {
    for (const [key, value] of Object.entries({
      TRUECALLER_APP_KEY: oldEnvironment.appKey,
      TRUECALLER_APP_NAME: oldEnvironment.appName,
      TRUECALLER_PRIVACY_URL: oldEnvironment.privacyUrl,
      TRUECALLER_TERMS_URL: oldEnvironment.termsUrl,
    })) {
      if (typeof value === 'undefined') delete process.env[key];
      else process.env[key] = value;
    }
  });
  configureTruecaller();

  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  let profileFetchCalled = false;
  globalThis.fetch = async (url, options) => {
    profileFetchCalled = true;
    assert.equal(url.toString(), 'https://profile4-noneu.truecaller.com/v1/default');
    assert.equal(options.headers.Authorization, 'Bearer consented-access-token');
    return new Response(JSON.stringify({
      name: { first: 'Ada', last: 'Lovelace' },
      phoneNumbers: ['1234567890'],
      onlineIdentities: { email: 'ada@example.test' },
      id: 'private-provider-id',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  await withServer(async (server) => {
    const start = await request(server, 'POST', '/api/truecaller/start', 'user-1');
    assert.equal(start.status, 200);
    assert.equal(typeof start.body.requestNonce, 'string');

    const callback = await request(server, 'POST', '/api/truecaller/callback/', null, {
      requestId: start.body.requestNonce,
      accessToken: 'consented-access-token',
      endpoint: 'https://profile4-noneu.truecaller.com/v1/default',
    });
    assert.equal(callback.status, 200);

    let result;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      result = await request(server, 'GET', `/api/truecaller/result/${encodeURIComponent(start.body.requestNonce)}`, 'user-1');
      if (result.body.status === 'complete' || result.body.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'complete');
    assert.deepEqual(result.body.profile, {
      name: 'Ada Lovelace',
      phoneNumbers: ['1234567890'],
      email: 'ada@example.test',
      addresses: [],
      jobTitle: null,
      companyName: null,
      aboutMe: null,
    });
    assert.equal(JSON.stringify(result.body).includes('private-provider-id'), false);
    assert.equal(profileFetchCalled, true);

    const otherUser = await request(
      server,
      'GET',
      `/api/truecaller/result/${encodeURIComponent(start.body.requestNonce)}`,
      'user-2',
    );
    assert.equal(otherUser.status, 404);
  });
});

test('Truecaller integration stays disabled without required configuration', async (t) => {
  const oldEnvironment = {
    appKey: process.env.TRUECALLER_APP_KEY,
    appName: process.env.TRUECALLER_APP_NAME,
    privacyUrl: process.env.TRUECALLER_PRIVACY_URL,
    termsUrl: process.env.TRUECALLER_TERMS_URL,
  };
  t.after(() => {
    for (const [key, value] of Object.entries({
      TRUECALLER_APP_KEY: oldEnvironment.appKey,
      TRUECALLER_APP_NAME: oldEnvironment.appName,
      TRUECALLER_PRIVACY_URL: oldEnvironment.privacyUrl,
      TRUECALLER_TERMS_URL: oldEnvironment.termsUrl,
    })) {
      if (typeof value === 'undefined') delete process.env[key];
      else process.env[key] = value;
    }
  });
  delete process.env.TRUECALLER_APP_KEY;
  delete process.env.TRUECALLER_APP_NAME;
  delete process.env.TRUECALLER_PRIVACY_URL;
  delete process.env.TRUECALLER_TERMS_URL;

  await withServer(async (server) => {
    const start = await request(server, 'POST', '/api/truecaller/start', 'user-1');
    assert.equal(start.status, 503);
    assert.match(start.body.error, /no está configurada/);
  });
});
