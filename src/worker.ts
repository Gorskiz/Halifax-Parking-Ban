interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/rss') {
      try {
        const response = await fetch(
          'https://www.halifax.ca/news/category/rss-feed?category=22',
          { headers: { 'User-Agent': 'HalifaxParkingBan/1.0' } }
        );
        if (!response.ok) {
          return new Response('Failed to fetch RSS feed', { status: 502 });
        }
        const xml = await response.text();
        return new Response(xml, {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
            'Access-Control-Allow-Origin': '*',
          },
        });
      } catch {
        return new Response('Error fetching RSS feed', { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
