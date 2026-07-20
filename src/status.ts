export interface ParkingBanStatusPayload {
  isActive: boolean;
  zone1Active: boolean;
  zone2Active: boolean;
  enforcementDate: string | null;
  enforcementTime: string;
  lastUpdate: string;
  rawTitle: string;
  link: string;
}

export interface ParkingBanApiResponse {
  status: ParkingBanStatusPayload;
  source: 'service-updates' | 'rss' | 'cache' | 'season';
  checkedAt: string;
  stale: boolean;
  verified: boolean;
}

export const PARKING_BAN_URL =
  'https://www.halifax.ca/transportation/winter-operations/parking-ban';
export const SERVICE_UPDATES_URL =
  'https://www.halifax.ca/transportation/winter-operations/service-updates';

const ENFORCEMENT_TIME = '1:00 AM - 6:00 AM';

function decodeHtml(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    hellip: '…',
    lt: '<',
    nbsp: ' ',
    ndash: '–',
    mdash: '—',
    quot: '"',
  };

  return value.replace(
    /&(#x[\da-f]+|#\d+|[a-z]+);/gi,
    (entity, code: string) => {
      if (code[0] === '#') {
        const radix = code[1]?.toLowerCase() === 'x' ? 16 : 10;
        const number = Number.parseInt(code.slice(radix === 16 ? 2 : 1), radix);
        return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
      }
      return namedEntities[code.toLowerCase()] ?? entity;
    },
  );
}

function htmlToText(value: string): string {
  return decodeHtml(decodeHtml(
    value
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ))
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(item: string, tagName: string): string {
  const match = item.match(
    new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'),
  );
  if (!match) return '';
  return htmlToText(match[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1'));
}

function getZoneState(text: string, zone: 1 | 2): boolean {
  const normalized = text
    .toUpperCase()
    .replace(/[–—-]/g, ' ')
    .replace(/\s+/g, ' ');
  const zoneToken = `ZONE ${zone}`;

  const zoneFirst = normalized.match(
    new RegExp(`${zoneToken}.{0,140}?WILL (NOT )?BE ENFORCED`),
  );
  if (zoneFirst) return !zoneFirst[1];

  const enforcementFirst = normalized.match(
    new RegExp(`WILL (NOT )?BE ENFORCED.{0,180}?${zoneToken}`),
  );
  if (enforcementFirst) return !enforcementFirst[1];

  if (
    normalized.includes('ENFORCEMENT HAS BEEN LIFTED') ||
    normalized.includes('PARKING BAN HAS BEEN LIFTED')
  ) {
    return false;
  }

  return false;
}

function statusFromAnnouncement(
  title: string,
  description: string,
  publishedAt: Date,
  link: string,
): ParkingBanStatusPayload {
  const content = `${title} ${description}`;
  const normalized = content.toUpperCase().replace(/\s+/g, ' ');
  const lifted =
    normalized.includes('LIFTS ENFORCEMENT') ||
    normalized.includes('LIFTED ENFORCEMENT') ||
    normalized.includes('ENFORCEMENT HAS BEEN LIFTED') ||
    normalized.includes('WILL NOT BE ENFORCED');
  const enforced =
    normalized.includes('WILL BE ENFORCED') ||
    normalized.includes('CONTINUE TO BE ENFORCED') ||
    normalized.includes('PARKING BAN IS IN EFFECT');

  let zone1Active = false;
  let zone2Active = false;

  if (enforced && !lifted) {
    const mentionsZone1 = /ZONE\s*1/i.test(content);
    const mentionsZone2 = /ZONE\s*2/i.test(content);
    const bothZones =
      (mentionsZone1 && mentionsZone2) ||
      /BOTH\s+ZONE/i.test(content) ||
      (!mentionsZone1 && !mentionsZone2);
    zone1Active = bothZones || mentionsZone1;
    zone2Active = bothZones || mentionsZone2;
  } else if (enforced) {
    zone1Active = getZoneState(content, 1);
    zone2Active = getZoneState(content, 2);
  }

  const dateMatch = title.match(
    /(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*(?:Jan\.?|Feb\.?|Mar\.?|Apr\.?|May|Jun\.?|Jul\.?|Aug\.?|Sep\.?|Oct\.?|Nov\.?|Dec\.?)\s*\d+/i,
  );

  return {
    isActive: zone1Active || zone2Active,
    zone1Active,
    zone2Active,
    enforcementDate: dateMatch?.[0].replace(/\./g, '') ?? null,
    enforcementTime: ENFORCEMENT_TIME,
    lastUpdate: publishedAt.toISOString(),
    rawTitle: title,
    link: link || PARKING_BAN_URL,
  };
}

export function parseServiceUpdates(
  html: string,
  checkedAt = new Date(),
): ParkingBanStatusPayload {
  const tableMarker = html.search(
    /data-title=(?:"|')Overnight winter parking ban(?:"|')/i,
  );
  if (tableMarker < 0) {
    throw new Error('Parking-ban status table was not found');
  }

  const tableStart = html.lastIndexOf('<table', tableMarker);
  const tableEnd = html.indexOf('</table>', tableMarker);
  if (tableStart < 0 || tableEnd < 0) {
    throw new Error('Parking-ban status table was incomplete');
  }

  const table = html.slice(tableStart, tableEnd + 8);
  const cells = [...table.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)]
    .map((match) => htmlToText(match[1]))
    .filter(Boolean);
  const statusIndex = cells.findIndex((cell) => /^status\s*:?$/i.test(cell));
  const statusText = statusIndex >= 0 ? cells[statusIndex + 1] : '';

  if (!statusText || !/overnight winter parking ban/i.test(statusText)) {
    throw new Error('Parking-ban status text was not found');
  }

  const zone1Active = getZoneState(statusText, 1);
  const zone2Active = getZoneState(statusText, 2);
  const hasRecognizedState =
    /will (?:not )?be enforced/i.test(statusText) ||
    /enforcement has been lifted/i.test(statusText);

  if (!hasRecognizedState) {
    throw new Error(`Unrecognized parking-ban status: ${statusText}`);
  }

  return {
    isActive: zone1Active || zone2Active,
    zone1Active,
    zone2Active,
    enforcementDate: null,
    enforcementTime: ENFORCEMENT_TIME,
    lastUpdate: checkedAt.toISOString(),
    rawTitle: statusText,
    link: SERVICE_UPDATES_URL,
  };
}

export function parseRssFeed(xml: string): ParkingBanStatusPayload {
  if (!/<rss\b|<feed\b/i.test(xml) || /<html\b|<!doctype html/i.test(xml)) {
    throw new Error('Upstream did not return an RSS feed');
  }

  const candidates = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)]
    .map((match) => {
      const item = match[1];
      const title = extractTag(item, 'title');
      const description = extractTag(item, 'description');
      const publishedAt = new Date(extractTag(item, 'pubDate'));
      return {
        title,
        description,
        publishedAt,
        link: extractTag(item, 'link'),
      };
    })
    .filter(({ title, description, publishedAt }) => {
      const searchable = `${title} ${description}`;
      return (
        Number.isFinite(publishedAt.getTime()) &&
        /parking ban|winter parking|overnight parking/i.test(searchable)
      );
    })
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

  const latest = candidates[0];
  if (!latest) {
    throw new Error('RSS feed contained no parking-ban announcements');
  }

  return statusFromAnnouncement(
    latest.title,
    latest.description,
    latest.publishedAt,
    latest.link,
  );
}

export function isParkingBanSeason(date: Date): boolean {
  const month = date.getMonth();
  const day = date.getDate();
  return month === 0 || month === 1 || month === 2 || (month === 11 && day >= 15);
}

export function applySeasonGuard(
  status: ParkingBanStatusPayload,
  now: Date,
): ParkingBanStatusPayload {
  if (isParkingBanSeason(now)) return status;

  return {
    ...status,
    isActive: false,
    zone1Active: false,
    zone2Active: false,
    enforcementDate: null,
  };
}

export function createOffSeasonStatus(now: Date): ParkingBanStatusPayload {
  return {
    isActive: false,
    zone1Active: false,
    zone2Active: false,
    enforcementDate: null,
    enforcementTime: ENFORCEMENT_TIME,
    lastUpdate: now.toISOString(),
    rawTitle: 'The annual parking-ban season runs from December 15 to March 31',
    link: PARKING_BAN_URL,
  };
}
