// Cloudflare Worker function to proxy the Halifax RSS feed
// This avoids CORS issues and third-party proxy rate limits

const RSS_FEED_URL = 'https://www.halifax.ca/news/category/rss-feed?category=22';

export const onRequest: PagesFunction = async (context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // Handle CORS preflight
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  try {
    // Abort the upstream fetch after 7 s so the Worker fails fast — the
    // browser's own 8 s AbortController shouldn't have to carry the full wait.
    const upstreamAbort = new AbortController();
    const upstreamTimeoutId = setTimeout(() => upstreamAbort.abort(), 7000);

    const response = await fetch(RSS_FEED_URL, {
      signal: upstreamAbort.signal,
      headers: {
        'User-Agent': 'Halifax-Parking-Ban-App/1.0',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
    }).finally(() => clearTimeout(upstreamTimeoutId));

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: `Upstream returned ${response.status}` }),
        {
          status: response.status,
          headers: {
            ...headers,
            'Content-Type': 'application/json',
          },
        }
      );
    }

    const xmlText = await response.text();

    // Validate that we received XML, not an HTML error/block page.
    const trimmedText = xmlText.trim();
    const isXML = trimmedText.startsWith('<?xml') ||
                   trimmedText.startsWith('<rss') ||
                   trimmedText.startsWith('<feed');
    const isHTML = trimmedText.toLowerCase().startsWith('<!doctype html') ||
                    trimmedText.toLowerCase().startsWith('<html');

    // Cloudflare / CDN bot-challenge pages — surface as an error so the
    // client can show a useful message.
    const isBotBlock =
      xmlText.includes('Just a moment...') ||
      xmlText.includes('cf-browser-verification');

    if ((isHTML || !isXML) && isBotBlock) {
      return new Response(
        JSON.stringify({
          error: 'Halifax.ca returned HTML instead of XML. The site may be blocking automated requests.',
          details: 'Received bot-challenge page from upstream'
        }),
        {
          status: 503,
          headers: { ...headers, 'Content-Type': 'application/json' },
        }
      );
    }

    // Any other non-XML response (e.g. empty-category HTML page) means there
    // are no parking-ban news items — return a minimal empty RSS feed so the
    // client correctly derives isActive: false without erroring.
    if (isHTML || !isXML) {
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel></channel></rss>',
        {
          status: 200,
          headers: {
            ...headers,
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=60',
          },
        }
      );
    }

    return new Response(xmlText, {
      status: 200,
      headers: {
        ...headers,
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=60', // Cache for 1 minute at edge
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: `Failed to fetch RSS feed: ${message}` }),
      {
        status: 502,
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
      }
    );
  }
};
