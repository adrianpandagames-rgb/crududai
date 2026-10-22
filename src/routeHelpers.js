const MAX_REDIRECT_ITEMS = 20;
const MAX_PAGE_SIZE = 100;

const addJsonQueryParam = (url, key, value, maxItems = MAX_REDIRECT_ITEMS) => {
  if (!Array.isArray(value) || value.length === 0) {
    return url;
  }

  return `${url}&${key}=${encodeURIComponent(JSON.stringify(value.slice(0, maxItems)))}`;
};

// The page size is capped so a single request cannot load a whole table.
const parsePagination = (query) => {
  const page = Number.parseInt(query.page, 10);
  const pageSize = Number.parseInt(query.pageSize, 10);
  return {
    page: Number.isInteger(page) ? Math.max(page, 1) : 1,
    pageSize: Number.isInteger(pageSize) ? Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE) : 10,
  };
};

export { MAX_REDIRECT_ITEMS, MAX_PAGE_SIZE, addJsonQueryParam, parsePagination };
