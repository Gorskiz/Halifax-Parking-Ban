# Halifax Parking Ban

A beautiful, simple, mobile-first, and optimized website that displays the current status of the [Halifax winter parking ban](https://www.halifax.ca/transportation/winter-operations/parking-ban).

## Features

- **Real-time Status**: Easily and simply displays if the parking ban is ON or OFF.
- **Zone Information**: If the ban is active, clearly shows which zones are affected or not affected.
- **Mobile First**: Designed to be fast and accessible on mobile devices.
- **Data Source**: Uses the public RSS feed from Halifax.ca: [https://www.halifax.ca/news/category/rss-feed?category=22](https://www.halifax.ca/news/category/rss-feed?category=22)

## Tech Stack

- [Vite](https://vitejs.dev/) + [Cloudflare Vite Plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [TypeScript](https://www.typescriptlang.org/)
- [React](https://reactjs.org/)
- [Cloudflare Workers](https://workers.cloudflare.com/) - Hosting & CDN

## Development

```bash
# Install dependencies
npm install

# Start dev server (runs in Cloudflare Workers runtime)
npm run dev

# Build for production
npm run build

# Preview production build locally
npm run preview
```

## Deployment

This project uses the unified Cloudflare Workers platform with static assets.

### Setup Git-Connected Deployment (Workers Builds)

1. Push your code to GitHub
2. Log into the [Cloudflare Dashboard](https://dash.cloudflare.com/)
3. Go to **Workers & Pages** → **Create** → **Create Worker** → **Import from Git**
4. Select your GitHub repository
5. Cloudflare will auto-detect settings from `wrangler.jsonc`
6. Click **Deploy**

Cloudflare Workers Builds will automatically build and deploy on every push to your main branch.

### Manual Deployment

```bash
# Build and deploy to Cloudflare Workers
npm run deploy
```

## License

Open Source MIT License.
