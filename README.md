# Halifax Parking Ban

A beautiful, simple, mobile-first, and optimized website that displays the current status of the [Halifax winter parking ban](https://www.halifax.ca/transportation/winter-operations/parking-ban).

## Features

- **Real-time Status**: Easily and simply displays if the parking ban is ON or OFF.
- **Zone Information**: If the ban is active, clearly shows which zones are affected or not affected.
- **Mobile First**: Designed to be fast and accessible on mobile devices.
- **Data Source**: Uses the public RSS feed from Halifax.ca: [https://www.halifax.ca/news/category/rss-feed?category=22](https://www.halifax.ca/news/category/rss-feed?category=22)

## Tech Stack

- [Vite](https://vitejs.dev/)
- [TypeScript](https://www.typescriptlang.org/)
- [React](https://reactjs.org/)
- [Cloudflare Pages](https://pages.cloudflare.com/) - Hosting & CDN

## Development

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build

# Preview production build locally
npm run preview

# Test with Cloudflare Pages dev server
npm run pages:dev
```

## Deployment

This project is configured for automatic deployment via Cloudflare Pages Git integration.

### Setup Git-Connected Deployment

1. Push your code to GitHub
2. Log into the [Cloudflare Dashboard](https://dash.cloudflare.com/)
3. Go to **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**
4. Select your GitHub repository
5. Configure the build settings:
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
6. Click **Save and Deploy**

Cloudflare will automatically build and deploy on every push to your main branch, with preview deployments for pull requests.

### Manual Deployment

```bash
# Deploy to production
npm run deploy

# Deploy to preview (feature branch)
npm run deploy:preview
```

## License

Open Source MIT License.
