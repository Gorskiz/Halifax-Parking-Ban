import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applySeasonGuard,
  isParkingBanSeason,
  parseRssFeed,
  parseServiceUpdates,
} from '../src/status.ts';

function servicePage(status) {
  return `
    <!doctype html>
    <table data-title="Overnight winter parking ban">
      <thead><tr><th>Status:</th><th>${status}</th></tr></thead>
      <tbody><tr><td>Status:</td><td>${status}</td></tr></tbody>
    </table>
  `;
}

test('parses both-zone enforcement from the official status table', () => {
  const status = parseServiceUpdates(
    servicePage(
      'The overnight winter parking ban WILL BE ENFORCED in Zone 1 – Central and Zone 2 – Non-Central.',
    ),
    new Date('2026-02-12T12:00:00Z'),
  );

  assert.equal(status.isActive, true);
  assert.equal(status.zone1Active, true);
  assert.equal(status.zone2Active, true);
});

test('parses the current both-zone not-enforced wording', () => {
  const status = parseServiceUpdates(
    servicePage(
      'The overnight winter parking ban WILL NOT BE ENFORCED in Zone 1 – Central and Zone 2 – Non-Central.',
    ),
  );

  assert.equal(status.isActive, false);
  assert.equal(status.zone1Active, false);
  assert.equal(status.zone2Active, false);
});

test('parses a single-zone enforcement status', () => {
  const status = parseServiceUpdates(
    servicePage(
      'The overnight winter parking ban WILL BE ENFORCED in Zone 1 – Central.',
    ),
  );

  assert.equal(status.zone1Active, true);
  assert.equal(status.zone2Active, false);
});

test('RSS fallback chooses the newest relevant announcement', () => {
  const status = parseRssFeed(`
    <?xml version="1.0"?>
    <rss version="2.0"><channel>
      <item>
        <title>Municipality lifts enforcement of Overnight Winter Parking Ban</title>
        <link>https://www.halifax.ca/lifted</link>
        <description>Enforcement has been lifted in both Zone 1 &amp; Zone 2.</description>
        <pubDate>Mon, 23 Mar 2026 11:30:01 -0300</pubDate>
      </item>
      <item>
        <title>Municipal Overnight Winter Parking Ban will be enforced 1-6 a.m., Monday, March 23</title>
        <link>https://www.halifax.ca/enforced</link>
        <description>The ban will be enforced in Zone 1 and Zone 2.</description>
        <pubDate>Sun, 22 Mar 2026 09:21:41 -0300</pubDate>
      </item>
    </channel></rss>
  `);

  assert.equal(status.isActive, false);
  assert.equal(status.link, 'https://www.halifax.ca/lifted');
  assert.equal(status.lastUpdate, '2026-03-23T14:30:01.000Z');
});

test('season guard makes a stale active status safe after March 31', () => {
  const active = parseServiceUpdates(
    servicePage(
      'The overnight winter parking ban WILL BE ENFORCED in Zone 1 – Central and Zone 2 – Non-Central.',
    ),
  );
  const guarded = applySeasonGuard(active, new Date('2026-07-18T12:00:00-03:00'));

  assert.equal(guarded.isActive, false);
  assert.equal(guarded.zone1Active, false);
  assert.equal(guarded.zone2Active, false);
  assert.equal(isParkingBanSeason(new Date('2026-12-15T00:00:00-04:00')), true);
  assert.equal(isParkingBanSeason(new Date('2026-12-14T23:59:59-04:00')), false);
});
