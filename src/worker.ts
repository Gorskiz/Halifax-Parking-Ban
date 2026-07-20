/**
 * Cloudflare Worker entry point.
 *
 * /api/status reads the municipality's explicit Service Updates status first,
 * with the official RSS feed as a second signal. Both are queried through the
 * Halifax CDN and origin hostnames so a transient failure on either path does
 * not break first load. The last verified status is retained in Cloudflare's
 * edge cache and is only used if every live source is temporarily unavailable.
 */

import {
  applySeasonGuard,
  createOffSeasonStatus,
  isParkingBanSeason,
  parseRssFeed,
  parseServiceUpdates,
  type ParkingBanApiResponse,
  type ParkingBanStatusPayload,
} from './status';

interface Env {
  ASSETS: Fetcher;
  STATUS_STORE: DurableObjectNamespace;
}

interface ExecutionContextWithWaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

const SERVICE_URLS = [
  'https://cdn.halifax.ca/transportation/winter-operations/service-updates',
  'https://www.halifax.ca/transportation/winter-operations/service-updates',
];

const RSS_URLS = [
  'https://cdn.halifax.ca/news/category/rss-feed?category=22',
  'https://www.halifax.ca/news/category/rss-feed?category=22',
];

const STATUS_CACHE_KEY = new Request(
  'https://halifax-parking-ban-cache.internal/verified-status-v2',
);
const SOURCE_TIMEOUT_MS = 6000;
const STORE_URL = 'https://status-store.internal/status';

const JSON_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
};

function jsonResponse(body: ParkingBanApiResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      // Always revalidate with the Worker. The Worker itself keeps the
      // last-known-good value for upstream outages.
      'Cache-Control': 'no-store',
    },
  });
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html, application/rss+xml, application/xml;q=0.9, */*;q=0.1',
        'User-Agent': 'Halifax-Parking-Ban-App/2.0 (+https://halifaxparkingban.ca)',
      },
    });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function firstParsed<T>(
  urls: string[],
  parser: (body: string) => T,
): Promise<T> {
  return Promise.any(
    urls.map(async (url) => {
      const body = await fetchText(url);
      return parser(body);
    }),
  );
}

async function getLiveStatus(now: Date): Promise<{
  status: ParkingBanStatusPayload;
  source: 'service-updates' | 'rss';
}> {
  const [serviceResult, rssResult] = await Promise.allSettled([
    firstParsed(SERVICE_URLS, (html) => parseServiceUpdates(html, now)),
    firstParsed(RSS_URLS, parseRssFeed),
  ]);

  // The explicit status table is authoritative. RSS is a fallback for times
  // when Halifax changes or temporarily fails to serve that page.
  if (serviceResult.status === 'fulfilled') {
    return {
      status: applySeasonGuard(serviceResult.value, now),
      source: 'service-updates',
    };
  }
  if (rssResult.status === 'fulfilled') {
    return {
      status: applySeasonGuard(rssResult.value, now),
      source: 'rss',
    };
  }

  throw new AggregateError(
    [serviceResult.reason, rssResult.reason],
    'Every official Halifax status source failed',
  );
}

function getDefaultCache(): Cache {
  return (caches as CacheStorage & { default: Cache }).default;
}

function getStatusStore(env: Env): DurableObjectStub {
  const id = env.STATUS_STORE.idFromName('halifax-parking-ban');
  return env.STATUS_STORE.get(id);
}

async function readLastKnownGood(env: Env): Promise<ParkingBanApiResponse | null> {
  try {
    const durableResponse = await getStatusStore(env).fetch(STORE_URL);
    if (durableResponse.ok) {
      return (await durableResponse.json()) as ParkingBanApiResponse;
    }
  } catch (error) {
    console.warn('Durable status store read failed; trying edge cache', error);
  }

  const cached = await getDefaultCache().match(STATUS_CACHE_KEY);
  if (!cached) return null;

  try {
    return (await cached.json()) as ParkingBanApiResponse;
  } catch {
    return null;
  }
}

async function saveLastKnownGood(
  env: Env,
  response: ParkingBanApiResponse,
): Promise<void> {
  const serialized = JSON.stringify(response);
  await Promise.allSettled([
    getStatusStore(env).fetch(STORE_URL, {
      method: 'PUT',
      body: serialized,
      headers: { 'Content-Type': 'application/json' },
    }),
    getDefaultCache().put(
      STATUS_CACHE_KEY,
      new Response(serialized, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          // This is deliberately long-lived: it is an emergency fallback, not
          // the normal response cache. Every request still tries live sources.
          'Cache-Control': 'public, max-age=31536000',
        },
      }),
    ),
  ]);
}

async function handleStatus(
  env: Env,
  context: ExecutionContextWithWaitUntil,
): Promise<Response> {
  const now = new Date();

  try {
    const live = await getLiveStatus(now);
    const payload: ParkingBanApiResponse = {
      status: live.status,
      source: live.source,
      checkedAt: now.toISOString(),
      stale: false,
      verified: true,
    };
    context.waitUntil(saveLastKnownGood(env, payload));
    return jsonResponse(payload);
  } catch (error) {
    console.warn('Live Halifax status sources failed; using a safe fallback', error);

    const cached = await readLastKnownGood(env);
    if (cached) {
      return jsonResponse({
        ...cached,
        status: applySeasonGuard(cached.status, now),
        source: 'cache',
        checkedAt: now.toISOString(),
        stale: true,
        verified: true,
      });
    }

    // Halifax states that enforcement only occurs from Dec. 15 through
    // Mar. 31, so OFF is authoritative outside that window even on a totally
    // cold cache. In season, the four official source requests above normally
    // seed the shared fallback on the first request.
    if (!isParkingBanSeason(now)) {
      return jsonResponse({
        status: createOffSeasonStatus(now),
        source: 'season',
        checkedAt: now.toISOString(),
        stale: false,
        verified: true,
      });
    }

    // Do not pretend OFF is verified during the enforcement season. Keeping
    // this as HTTP 200 prevents a transient upstream 502 from leaking through,
    // while the verified flag lets the UI avoid presenting a false answer.
    return jsonResponse({
      status: createOffSeasonStatus(now),
      source: 'season',
      checkedAt: now.toISOString(),
      stale: true,
      verified: false,
    });
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContextWithWaitUntil,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/status' || url.pathname === '/api/rss') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: JSON_HEADERS });
      }
      if (request.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: JSON_HEADERS,
        });
      }
      return handleStatus(env, context);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    context: ExecutionContextWithWaitUntil,
  ): Promise<void> {
    const now = new Date();
    try {
      const live = await getLiveStatus(now);
      const payload: ParkingBanApiResponse = {
        status: live.status,
        source: live.source,
        checkedAt: now.toISOString(),
        stale: false,
        verified: true,
      };
      context.waitUntil(saveLastKnownGood(env, payload));
    } catch (error) {
      console.warn('Scheduled parking status refresh failed', error);
    }
  },
};

export class ParkingStatusStore {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === 'PUT') {
      const payload = (await request.json()) as ParkingBanApiResponse;
      await this.state.storage.put('status', payload);
      return new Response(null, { status: 204 });
    }

    const payload =
      await this.state.storage.get<ParkingBanApiResponse>('status');
    if (!payload) return new Response(null, { status: 404 });

    return new Response(JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
}
