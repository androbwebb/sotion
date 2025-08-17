# Notion Proxy Service with Email Tracking

A proxy service for Notion pages with HEAD injection capabilities, URL obfuscation, and email tracking pixel functionality.

## Features

- **Notion Page Proxy**: Obfuscate and proxy Notion pages
- **HEAD Injection**: Add custom scripts/snippets to page headers
- **Email Tracking Pixels**: Track email opens with invisible 1x1 pixel images
- **Detailed Analytics**: Capture timestamps, user agents, IPs, and referers

## Email Tracking Usage

### Embed Tracking Pixel in Email

Add this HTML to your email:

```html
<img src="http://your-server.com/pixel/unique-campaign-name" width="1" height="1" alt="">
```

Replace `unique-campaign-name` with any identifier for your email campaign.

### View Tracking Stats

**Get stats for specific pixel:**
```bash
curl http://your-server.com/stats/unique-campaign-name
```

**Get all tracking stats:**
```bash
curl http://your-server.com/stats
```

### Response Format

```json
{
  "firstOpened": "2025-08-17T10:43:47.795Z",
  "lastOpened": "2025-08-17T10:44:04.649Z",
  "totalOpens": 2,
  "opens": [
    {
      "timestamp": "2025-08-17T10:43:47.795Z",
      "userAgent": "Mozilla/5.0...",
      "ip": "192.168.1.1",
      "referer": "https://mail.google.com/"
    }
  ]
}
```

## Installation

```bash
npm install
npm start
```

## API Endpoints

### Email Tracking
- `GET /pixel/:name` - Tracking pixel endpoint (returns 1x1 transparent GIF)
- `GET /stats/:name` - Get tracking statistics for specific pixel
- `GET /stats` - Get all tracking statistics

### Notion Proxy
- `POST /register` - Register a Notion URL and get obfuscated proxy URL
- `GET /p/:id` - Access proxied Notion page
- `POST /config` - Update HEAD snippet configuration
- `GET /list` - List all registered URLs

## Notes

- Tracking data is currently stored in memory (resets on server restart)
- For production use, consider implementing persistent database storage
- The pixel endpoint includes cache-busting headers to ensure tracking accuracy