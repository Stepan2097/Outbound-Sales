import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanReason } from './lib/reasons.mjs';

// 28.10: «The operation was aborted due to timeout» told the owner nothing.
test('a failure is said in words, and an unknown one as it came', () => {
  assert.match(humanReason('The operation was aborted due to timeout'), /серверна Anty не відповіла вчасно/);
  assert.match(humanReason('gulajpoleamis@gmail.com is already running in Anty'), /попередня сесія не закрила браузер/);
  assert.match(humanReason('page.$$eval: Target crashed '), /вкладка браузера впала/);
  assert.match(humanReason('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://api.ipify.org/'), /проксі профілю не відповідає/);
  assert.equal(humanReason('щось зовсім нове'), 'щось зовсім нове');
  assert.match(humanReason(''), /причини агент не записав/);
});
