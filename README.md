# Notion Proxy Service

A proxy service for Notion pages with HEAD injection, URL obfuscation, and auto-discovery.

## Features

- 🔗 **URL Obfuscation**: Generates short, random IDs instead of exposing Notion URLs
- 📝 **HEAD Injection**: Add custom scripts, styles, or meta tags to proxied pages
- 🔍 **Auto-Discovery**: Multiple discovery methods including Notion API
- 🤖 **Smart Link Detection**: Automatically finds and proxies linked Notion pages
- 💾 **Persistent Storage**: PostgreSQL database for reliable storage across restarts
- 📊 **Analytics**: Tracks access counts and last accessed time for each page
- 🔄 **Notion API Integration**: Discover entire workspaces or specific databases

## Setup

### Auto-Discovery Options

1. **Notion API** (Most Powerful):
   ```bash
   NOTION_TOKEN=secret_abc123...
   NOTION_DISCOVER_WORKSPACE=true  # Discover all workspace pages
   NOTION_DATABASE_IDS=db-id-1,db-id-2  # Or specific databases
   ```

2. **Smart Link Detection**:
   ```bash
   AUTO_DISCOVER_LINKS=true  # Auto-register linked pages
   ```

3. **Manual URLs**:
   ```bash
   NOTION_PAGES=https://www.notion.so/page1,https://www.notion.so/page2
   ```

4. **Config File** (`pages.json`):
   ```json
   [
     "https://www.notion.so/your-page-id",
     {
       "id": "custom-id",
       "url": "https://www.notion.so/another-page"
     }
   ]
   ```

### Deployment on Render

1. Push to GitHub
2. Connect repo to Render (it will auto-detect `render.yaml`)
3. Add a PostgreSQL database to your service (or use existing `sotion` database)
4. Add environment variables:
   - `DATABASE_URL` - Your PostgreSQL connection string (Render provides this)
   - `ROOT_NOTION_PAGE` - Your main Notion page URL
   - `AUTO_DISCOVER_LINKS=true` - Auto-register linked pages (recommended)
   - `NOTION_TOKEN` - Your Notion integration token (optional)
   - `NOTION_DISCOVER_WORKSPACE=true` - Auto-discover all pages (optional)
5. Deploy!

## API Endpoints

- `GET /` - Redirects to root page (if configured)
- `GET /p/:id` - Access proxied Notion page
- `POST /register` - Manually register a new Notion URL
- `GET /list` - List all registered URLs with analytics
- `GET /health` - Health check endpoint

## Local Development

```bash
npm install

# Create .env file with your settings:
cp .env.example .env

# For local development with database:
# 1. Install PostgreSQL locally
# 2. Create a database called 'sotion'
# 3. Set DATABASE_URL in .env file
DATABASE_URL=postgresql://user:password@localhost:5432/sotion

# Add your root page and discovery options:
ROOT_NOTION_PAGE=https://andrewwebb.notion.site/Irina-2524e71be63880238e6bfdc6479f86b7
AUTO_DISCOVER_LINKS=true

# Add Notion API token (optional):
NOTION_TOKEN=secret_...
NOTION_DISCOVER_WORKSPACE=true

# Or run without database (in-memory mode):
npm run dev
```

## Notion API Setup

1. Go to https://www.notion.so/my-integrations
2. Create a new integration
3. Copy the integration token
4. Share your Notion pages/databases with the integration
5. Add the token as `NOTION_TOKEN` environment variable
