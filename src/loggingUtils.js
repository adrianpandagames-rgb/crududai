export const maskApiKeyInUrl = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  return value.replace(/(API_KEY=)([^&]+)/gi, '$1[REDACTED]');
};
