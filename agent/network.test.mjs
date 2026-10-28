import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConnections } from './lib/network.mjs';

// A page with an endless list: every look shows ten more people.
function endlessPage() {
  let shown = 0;
  return {
    goto: async () => {},
    mouse: { wheel: async () => {}, move: async () => {} },
    evaluate: async (fn) => {
      const source = String(fn);
      if (source.includes('ConnectionCard_')) {
        shown += 10;
        return Array.from({ length: shown }, (_, i) => ({ href: `/in/person-${i}/`, lines: [`Person ${i}`, 'Media buyer'] }));
      }
      if (source.includes('контакт')) return 5000;
      return null;
    },
    locator: () => ({ first: () => ({ hover: async () => {}, boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 100 }) }), boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 100 }), hover: async () => {} })
  };
}

// 28.10: 2365 contacts on one page took the server's browser to 4 GB.
test('a contacts read stops, incomplete, when the tab grows too big or it takes too long', async () => {
  const lines = [];
  let heap = 100;
  const byHeap = await readConnections(endlessPage(), { sleep: async () => {}, log: (line) => lines.push(line), pauseMs: 0,
    heapMb: async () => (heap += 100) });
  assert.equal(byHeap.complete, false);
  assert.ok(byHeap.people.length < 5000);
  assert.ok(lines.some((line) => /зупиняюсь на \d+ — вкладка вже \d+ МБ/.test(line)));

  let clock = 0;
  const byTime = await readConnections(endlessPage(), { sleep: async () => {}, log: () => {}, pauseMs: 0,
    heapMb: async () => 100, now: () => (clock += 60_000) });
  assert.equal(byTime.complete, false);
  assert.ok(byTime.people.length < 5000);
});
