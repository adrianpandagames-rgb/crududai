import crypto from 'node:crypto';
import express from 'express';

const REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_REQUESTS_PER_USER = 3;
const pendingRequests = new Map();

const getTruecallerConfig = () => {
  const appKey = String(process.env.TRUECALLER_APP_KEY || '').trim();
  const appName = String(process.env.TRUECALLER_APP_NAME || '').trim();
  const privacyUrl = String(process.env.TRUECALLER_PRIVACY_URL || '').trim();
  const termsUrl = String(process.env.TRUECALLER_TERMS_URL || '').trim();
  const validHttpsUrl = (value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  };

  return {
    appKey,
    appName,
    privacyUrl,
    termsUrl,
    enabled: Boolean(appKey && appName && validHttpsUrl(privacyUrl) && validHttpsUrl(termsUrl)),
  };
};

const removeExpiredRequests = () => {
  const expiredBefore = Date.now() - REQUEST_TTL_MS;
  for (const [requestId, request] of pendingRequests) {
    if (request.createdAt <= expiredBefore) pendingRequests.delete(requestId);
  }
};

const boundedString = (value, maxLength = 200) => (
  typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null
);

const normalizeProfile = (profile) => {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('Invalid Truecaller profile response.');
  }

  const name = profile.name && typeof profile.name === 'object' ? profile.name : {};
  const identities = profile.onlineIdentities && typeof profile.onlineIdentities === 'object'
    ? profile.onlineIdentities
    : {};
  const addresses = Array.isArray(profile.addresses)
    ? profile.addresses.slice(0, 5).filter((address) => address && typeof address === 'object').map((address) => ({
      countryCode: boundedString(address.countryCode, 10),
      city: boundedString(address.city),
      street: boundedString(address.street),
      zipcode: boundedString(address.zipcode, 30),
    }))
    : [];

  return {
    name: [boundedString(name.first, 100), boundedString(name.last, 100)].filter(Boolean).join(' ') || null,
    phoneNumbers: Array.isArray(profile.phoneNumbers)
      ? profile.phoneNumbers.filter((number) => typeof number === 'string').slice(0, 5).map((number) => number.slice(0, 30))
      : [],
    email: boundedString(identities.email, 254),
    addresses,
    jobTitle: boundedString(profile.jobTitle),
    companyName: boundedString(profile.companyName),
    aboutMe: boundedString(profile.aboutMe, 500),
  };
};

const fetchTruecallerProfile = async (endpoint, accessToken) => {
  let profileUrl;
  try {
    profileUrl = new URL(endpoint);
  } catch {
    throw new Error('Invalid Truecaller profile endpoint.');
  }

  if (profileUrl.protocol !== 'https:' || profileUrl.port || profileUrl.username || profileUrl.password
    || (profileUrl.hostname !== 'truecaller.com' && !profileUrl.hostname.endsWith('.truecaller.com'))) {
    throw new Error('Untrusted Truecaller profile endpoint.');
  }

  const response = await fetch(profileUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Cache-Control': 'no-cache',
      Accept: 'application/json',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Truecaller profile request failed with status ${response.status}.`);
  return normalizeProfile(await response.json());
};

const createCallbackRouter = () => {
  const router = express.Router();

  router.post('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    removeExpiredRequests();

    const { requestId, status, accessToken, endpoint } = req.body || {};
    if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 200) {
      return res.status(400).send('Invalid request.');
    }

    const request = pendingRequests.get(requestId);
    if (!request) return res.sendStatus(200);
    if (['processing', 'complete', 'rejected'].includes(request.status)) return res.sendStatus(200);

    if (status === 'flow_invoked') {
      if (request.status === 'pending') request.status = 'flow_invoked';
      return res.sendStatus(200);
    }
    if (status === 'user_rejected') {
      request.status = 'rejected';
      return res.sendStatus(200);
    }
    if (typeof accessToken !== 'string' || accessToken.length < 1 || accessToken.length > 2048
      || typeof endpoint !== 'string' || endpoint.length > 2048) {
      request.status = 'failed';
      return res.sendStatus(200);
    }

    request.status = 'processing';
    res.sendStatus(200);
    fetchTruecallerProfile(endpoint, accessToken)
      .then((profile) => {
        if (pendingRequests.get(requestId) === request) {
          request.profile = profile;
          request.status = 'complete';
        }
      })
      .catch((error) => {
        if (pendingRequests.get(requestId) === request) request.status = 'failed';
        console.error('Truecaller profile retrieval failed:', error.name);
      });
  });

  return router;
};

const createUserRouter = () => {
  const router = express.Router();

  router.post('/start', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const config = getTruecallerConfig();
    if (!config.enabled) {
      return res.status(503).json({ error: 'La integración con Truecaller no está configurada en el servidor.' });
    }

    removeExpiredRequests();
    const userId = String(req.session.userId);
    const userRequests = [...pendingRequests.entries()]
      .filter(([, request]) => request.userId === userId)
      .sort((left, right) => left[1].createdAt - right[1].createdAt);
    if (userRequests.length >= MAX_PENDING_REQUESTS_PER_USER) {
      return res.status(429).json({ error: 'Ya hay varias verificaciones pendientes. Espera antes de iniciar otra.' });
    }

    const requestNonce = crypto.randomBytes(24).toString('base64url');
    pendingRequests.set(requestNonce, {
      userId,
      status: 'pending',
      createdAt: Date.now(),
      profile: null,
    });

    return res.json({
      requestNonce,
      partnerKey: config.appKey,
      partnerName: config.appName,
      privacyUrl: config.privacyUrl,
      termsUrl: config.termsUrl,
    });
  });

  router.get('/result/:requestId', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    removeExpiredRequests();
    const request = pendingRequests.get(req.params.requestId);
    if (!request || request.userId !== String(req.session.userId)) {
      return res.status(404).json({ error: 'La solicitud no existe o expiró.' });
    }

    return res.json({ status: request.status, profile: request.profile });
  });

  return router;
};

export const isTruecallerConfigured = () => getTruecallerConfig().enabled;
export const createTruecallerIntegration = () => ({
  callbackRouter: createCallbackRouter(),
  userRouter: createUserRouter(),
});
