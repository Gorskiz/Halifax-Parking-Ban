/**
 * Cloudflare Worker entry point.
 * Proxies the Halifax RSS feed at /api/rss to avoid browser CORS restrictions,
 * and delegates everything else to the static asset binding.
 */

interface Env {
  ASSETS: Fetcher;
}

const RSS_FEED_URL = 'https://www.halifax.ca/news/category/rss-feed?category=22';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/rss') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: CORS_HEADERS });
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7000);

        const upstream = await fetch(RSS_FEED_URL, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Halifax-Parking-Ban-App/1.0',
            'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          },
        }).finally(() => clearTimeout(timeoutId));

        if (!upstream.ok) {
          return new Response(
            JSON.stringify({ error: `Upstream returned ${upstream.status}` }),
            { status: upstream.status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }

        const xml = await upstream.text();
        const trimmed = xml.trim();

        // Detect bot-challenge / error pages from upstream CDN
        const isBotBlock =
          trimmed.includes('Just a moment...') ||
          trimmed.includes('cf-browser-verification');
        const isHTML =
          trimmed.toLowerCase().startsWith('<!doctype html') ||
          trimmed.toLowerCase().startsWith('<html');
        const isXML =
          trimmed.startsWith('<?xml') ||
          trimmed.startsWith('<rss') ||
          trimmed.startsWith('<feed');

        if (isBotBlock) {
          return new Response(
            JSON.stringify({ error: 'Halifax.ca returned a bot-challenge page instead of the RSS feed.' }),
            { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }

        if (isHTML || !isXML) {
          // Return an empty-but-valid RSS feed so the client correctly shows
          // "no active ban" rather than an error when the category has no items.
          return new Response(
            '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel></channel></rss>',
            { headers: { ...CORS_HEADERS, 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=60' } }
          );
        }

        return new Response(xml, {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=60',
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return new Response(
          JSON.stringify({ error: `Failed to fetch RSS feed: ${message}` }),
          { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
    }

    // All other requests — serve the static React app
    return env.ASSETS.fetch(request);
  },
};
