const ROUTE_METHODS = ['use', 'all', 'get', 'post', 'put', 'patch', 'delete'];
const GENERIC_ERROR_MESSAGE = 'Ocurrió un error interno. Intenta nuevamente.';

// Express 4 ignores promises returned by handlers, so a rejected async handler
// leaves the request hanging. This forwards those rejections to next().
const wrapHandler = (handler) => {
  if (Array.isArray(handler)) return handler.map(wrapHandler);
  // Error handlers keep their arity; routers and sub-apps already handle errors.
  if (typeof handler !== 'function' || handler.length === 4 || typeof handler.handle === 'function') return handler;
  return function forwardAsyncError(req, res, next) {
    const result = handler.call(this, req, res, next);
    if (result && typeof result.catch === 'function') result.catch(next);
    return result;
  };
};

const forwardAsyncErrors = (target) => {
  for (const method of ROUTE_METHODS) {
    const original = target[method];
    target[method] = function (...args) {
      return original.apply(this, args.map(wrapHandler));
    };
  }
  return target;
};

const errorStatus = (error) => {
  const status = Number(error?.status ?? error?.statusCode);
  return Number.isInteger(status) && status >= 400 && status < 500 ? status : 500;
};

const wantsJson = (req) => req.path === '/api' || req.path.startsWith('/api/') || req.xhr || !req.accepts('html');

// Client errors (4xx) carry a message meant for the user; anything else is
// logged and replaced with a generic message so internals never leak.
const handleErrors = (error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = errorStatus(error);
  if (status === 500) console.error(`Error en ${req.method} ${req.originalUrl}:`, error?.stack || error);
  const message = status === 500 ? GENERIC_ERROR_MESSAGE : (error.message || GENERIC_ERROR_MESSAGE);
  if (wantsJson(req)) return res.status(status).json({ error: message });
  return res.status(status).render('error', { status, message });
};

export { forwardAsyncErrors, handleErrors, errorStatus, GENERIC_ERROR_MESSAGE };
