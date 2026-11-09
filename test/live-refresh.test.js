import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// A tiny DOM with the one behaviour this bug depends on: replaceChildren *moves* nodes out of the document
// they came from, as browsers do with nodes from a DOMParser document.
class FakeNode {
  constructor(attrs = {}, children = []) {
    this.attrs = attrs;
    this.id = attrs.id || '';
    this.dataset = { liveRefresh: attrs['data-live-refresh'] || '' };
    this.parent = null;
    this.children = [];
    for (const child of children) this.append(child);
  }

  append(child) {
    if (child.parent) child.parent.children = child.parent.children.filter((node) => node !== child);
    child.parent = this;
    this.children.push(child);
  }

  get childNodes() { return [...this.children]; }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    for (const node of nodes) this.append(node);
  }

  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }

  matches(selector) {
    const attr = selector.match(/^\[([\w-]+)\]$/);
    if (attr) return attr[1] in this.attrs;
    if (selector.startsWith('.')) return (this.attrs.class || '').split(' ').includes(selector.slice(1));
    return false;
  }

  querySelector(selector) { for (const node of this.walk()) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { return [...this.walk()].filter((node) => node.matches(selector)); }
  getElementById(id) { for (const node of this.walk()) if (node.id === id) return node; return null; }
}

// Page like Ruta: the marker lives inside the region that gets swapped.
const page = (pending, label) => new FakeNode({}, [
  new FakeNode({ id: 'rutaArchivos', 'data-live-region': '' }, [
    ...(pending ? [new FakeNode({ 'data-live-refresh': '' })] : []),
    new FakeNode({ class: label }),
  ]),
]);

test('keeps polling while the refreshed page still has files in process, and stops once they finish', async () => {
  const responses = [page(true, 'ronda-1'), page(true, 'ronda-2'), page(false, 'listo')];
  const parsed = new Map(responses.map((doc, index) => [`html-${index}`, doc]));
  let fetches = 0;
  const timers = [];
  const document = page(true, 'inicial');
  document.hidden = false;
  document.addEventListener = () => {};

  const context = vm.createContext({
    document,
    location: { pathname: '/ruta', search: '' },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    fetch: async () => {
      const body = `html-${fetches++}`;
      return { ok: true, redirected: false, text: async () => body };
    },
    DOMParser: class { parseFromString(text) { return parsed.get(text); } },
  });
  vm.runInContext(fs.readFileSync('public/js/live-refresh.js', 'utf8'), context);

  // Run each scheduled round until the script stops scheduling.
  for (let round = 0; round < 10 && timers.length; round += 1) {
    await timers.shift()();
  }

  assert.equal(fetches, 3, 'asks again after each round that still shows files in process');
  assert.equal(timers.length, 0, 'stops once the page comes back without files in process');
  const region = document.getElementById('rutaArchivos');
  assert.ok(region.querySelector('.listo'), 'the table shows the finished state');
  assert.equal(region.querySelector('[data-live-refresh]'), null);
});
