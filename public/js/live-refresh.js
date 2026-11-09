// While a page shows files still in process (a [data-live-refresh] marker), it asks the server for the same page
// every few seconds and swaps in the contents of each [data-live-region] by id, instead of reloading: no entrance
// animation, no repeated notice, and what the person is typing or scrolling stays put. It stops once the server
// renders the page without the marker. The marker's value, in milliseconds, sets the pace (5 seconds otherwise).
(() => {
  let marker = document.querySelector('[data-live-refresh]');
  if (!marker) return;
  let timer = 0;
  const schedule = () => { timer = setTimeout(refresh, Math.max(Number(marker.dataset.liveRefresh) || 5000, 1000)); };
  async function refresh() {
    timer = 0;
    // A delete confirmation waiting for an answer belongs to the rows on screen; try again later.
    if (document.querySelector('.confirm-toast') || document.hidden) return schedule();
    try {
      const response = await fetch(location.pathname + location.search, { headers: { Accept: 'text/html' }, cache: 'no-store' });
      // A finished session redirects to the login page; leave the page as it is.
      if (!response.ok || response.redirected) return;
      const next = new DOMParser().parseFromString(await response.text(), 'text/html');
      // Read the marker before the swap: replaceChildren moves the nodes out of `next`, and the marker usually
      // sits inside a region, so looking for it afterwards always came back empty and polling stopped after one round.
      const nextMarker = next.querySelector('[data-live-refresh]');
      for (const region of document.querySelectorAll('[data-live-region]')) {
        const fresh = next.getElementById(region.id);
        if (fresh) region.replaceChildren(...fresh.childNodes);
      }
      marker = nextMarker;
      if (marker) schedule();
    } catch {
      schedule(); // A dropped connection retries on the next round.
    }
  }
  document.addEventListener('visibilitychange', () => {
    // Back on the tab: check right away instead of waiting out the round. No timer means polling has ended.
    if (!document.hidden && timer) { clearTimeout(timer); refresh(); }
  });
  schedule();
})();
