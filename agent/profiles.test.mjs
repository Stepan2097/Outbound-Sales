import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveProfiles, vanitySlug } from './lib/profiles.mjs';

/**
 * Хто людина з розмови насправді (власник 19.10: «іноді показує тільки імя…
 * не робочі посилання… дублі»): розмова → посилання співрозмовника → профіль,
 * і LinkedIn сам каже справжню адресу й повне ім'я.
 */

const sleep = async () => {};

function fakePage(profiles) {
  const visits = [];
  let url = 'about:blank';
  return {
    visits,
    async goto(next) { visits.push(next); const member = (next.match(/\/in\/([^/]+)\//) || [])[1]; url = member && profiles[member] ? profiles[member].url : next; },
    url: () => url,
    async evaluate() { const found = Object.values(profiles).find((p) => p.url === url); return { url, name: found?.name ?? null, headline: found?.headline ?? null }; }
  };
}

test('vanity — лише справжня адреса профілю, не id учасника', () => {
  assert.equal(vanitySlug('https://www.linkedin.com/in/milo%C5%A1-markovi%C4%87-1990/'), 'miloš-marković-1990');
  assert.equal(vanitySlug('https://www.linkedin.com/in/ACoAAC3a0tSbSMXZnrsyp1eAo9VTYVkSqPA44m8/'), null);
  assert.equal(vanitySlug('https://www.linkedin.com/feed/'), null);
});

test('кожна людина: розмова, її профіль за посиланням із розмови, і порталу — адреса й повне ім\'я; невдача теж іде на портал', async () => {
  const page = fakePage({
    ACoAAMilos: { url: 'https://www.linkedin.com/in/milos-markovic-1990/', name: 'Miloš Marković', headline: 'CMO at Apps' }
  });
  const sent = [];
  const portal = { profileResolved: async (answer) => { sent.push(answer); return { success: true, merged: answer.contactId === 'c-1' }; } };
  const result = await resolveProfiles(page, [
    { contactId: 'c-1', threadKey: 't-1' },
    { contactId: 'c-2', threadKey: 't-2' }
  ], {
    portal, sleep, self: { slug: 'me', name: 'Mary' },
    participant: async (_page, threadKey) => (threadKey === 't-1' ? { member: 'ACoAAMilos' } : { failed: 'no_participant_link' })
  });
  assert.deepEqual(result, { resolved: 1, failed: 1 });
  assert.deepEqual(sent[0], { contactId: 'c-1', threadKey: 't-1', memberId: 'ACoAAMilos', vanity: 'milos-markovic-1990', name: 'Miloš Marković', headline: 'CMO at Apps' });
  assert.deepEqual(sent[1], { contactId: 'c-2', threadKey: 't-2', failed: 'no_participant_link' });
  assert.ok(page.visits[0].includes('/messaging/thread/t-1/'));
  assert.ok(page.visits[1].endsWith('/in/ACoAAMilos/'), 'профіль — за id у його власному написанні');
});

test('id у власному написанні — одразу профіль, без розмови', async () => {
  const page = fakePage({ ACoAAJelena: { url: 'https://www.linkedin.com/in/jelena-tomic/', name: 'Jelena Tomić', headline: null } });
  const sent = [];
  await resolveProfiles(page, [{ contactId: 'c-j', threadKey: 't-j', memberId: 'ACoAAJelena' }], {
    portal: { profileResolved: async (answer) => { sent.push(answer); return { success: true }; } }, sleep,
    participant: async () => { throw new Error('розмову не відкривати'); }
  });
  assert.equal(page.visits.length, 1);
  assert.equal(sent[0].vanity, 'jelena-tomic');
  assert.equal(sent[0].name, 'Jelena Tomić');
});
