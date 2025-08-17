import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { readFileSync, existsSync } from 'fs';
import { 
  initDatabase, 
  getAllMappings, 
  getMapping, 
  createMapping, 
  deleteMapping,
  getHeadConfigs,
  saveHeadConfigs,
  autoDiscoverFromEnv,
  recordTracking,
  getCachedAsset,
  setCachedAsset,
  getCacheStats,
  clearCache,
  getMappingByPath,
  getRootMapping,
  setRootMapping
} from './database.js';
import { initNotionClient, autoDiscoverViaAPI } from './notion-api.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Fallback in-memory storage if database is not available
const fallbackUrlMap = new Map();
const fallbackTracking = new Map();
let headConfig = { globalSnippets: [], pageSpecificSnippets: {} };
let usingDatabase = true;

app.use(express.json());

// Initialize database and auto-discover pages
async function initialize() {
  try {
    if (process.env.DATABASE_URL) {
      await initDatabase();
      await autoDiscoverFromEnv();
      
      // Initialize Notion API and discover pages
      if (initNotionClient()) {
        await autoDiscoverViaAPI();
      }
      
      // Set up root mapping if configured
      if (process.env.ROOT_NOTION_PAGE) {
        await setRootMapping(process.env.ROOT_NOTION_PAGE);
        console.log(`Root mapping set: / -> ${process.env.ROOT_NOTION_PAGE}`);
      }
      
      headConfig = await getHeadConfigs();
      console.log('Database initialized successfully');
    } else {
      console.log('No DATABASE_URL found, using in-memory storage (will not persist)');
      usingDatabase = false;
      autoDiscoverFromMemory();
    }
  } catch (error) {
    console.error('Failed to initialize database, using in-memory storage:', error);
    usingDatabase = false;
    autoDiscoverFromMemory();
  }
}

// Fallback auto-discovery for in-memory mode
function autoDiscoverFromMemory() {
  const envPages = process.env.NOTION_PAGES;
  if (envPages) {
    const urls = envPages.split(',').map(url => url.trim()).filter(Boolean);
    urls.forEach(url => {
      const id = Math.random().toString(36).substring(2, 12);
      fallbackUrlMap.set(id, url);
      console.log(`Auto-registered (memory): ${url} -> ${id}`);
    });
  }
  
  try {
    if (existsSync('./pages.json')) {
      const pages = JSON.parse(readFileSync('./pages.json', 'utf8'));
      if (Array.isArray(pages)) {
        pages.forEach(page => {
          if (typeof page === 'string') {
            const id = Math.random().toString(36).substring(2, 12);
            fallbackUrlMap.set(id, page);
            console.log(`Auto-registered from pages.json (memory): ${page} -> ${id}`);
          } else if (page.url) {
            const id = page.id || Math.random().toString(36).substring(2, 12);
            fallbackUrlMap.set(id, page.url);
            console.log(`Auto-registered from pages.json (memory): ${page.url} -> ${id}`);
          }
        });
      }
    }
  } catch (e) {
    // No pages.json found
  }
}

// Endpoint to register a new Notion page and get obfuscated URL
app.post('/register', async (req, res) => {
  const { notionUrl, path, isRoot } = req.body;
  
  if (!notionUrl) {
    return res.status(400).json({ error: 'notionUrl is required' });
  }
  
  // Validate path if provided
  if (path && !path.startsWith('/')) {
    return res.status(400).json({ error: 'Path must start with /' });
  }
  
  let id;
  if (usingDatabase) {
    // If marking as root, use setRootMapping
    if (isRoot) {
      id = await setRootMapping(notionUrl);
    } else {
      id = await createMapping(notionUrl, null, path);
    }
    if (!id) {
      return res.status(500).json({ error: 'Failed to create mapping' });
    }
  } else {
    id = Math.random().toString(36).substring(2, 12);
    fallbackUrlMap.set(id, notionUrl);
  }
  
  const response = {
    id,
    legacyUrl: `${req.protocol}://${req.get('host')}/p/${id}`
  };
  
  if (path) {
    response.transparentUrl = `${req.protocol}://${req.get('host')}${path}`;
  }
  
  if (isRoot) {
    response.transparentUrl = `${req.protocol}://${req.get('host')}/`;
  }
  
  res.json(response);
});

// Helper function to detect MIME type from path
function getMimeType(path) {
  if (path.endsWith('.js') || path.endsWith('.mjs')) {
    return 'application/javascript';
  } else if (path.endsWith('.css')) {
    return 'text/css';
  } else if (path.endsWith('.png')) {
    return 'image/png';
  } else if (path.endsWith('.jpg') || path.endsWith('.jpeg')) {
    return 'image/jpeg';
  } else if (path.endsWith('.gif')) {
    return 'image/gif';
  } else if (path.endsWith('.svg')) {
    return 'image/svg+xml';
  } else if (path.endsWith('.ico')) {
    return 'image/x-icon';
  } else if (path.endsWith('.woff')) {
    return 'font/woff';
  } else if (path.endsWith('.woff2')) {
    return 'font/woff2';
  } else if (path.endsWith('.ttf')) {
    return 'font/ttf';
  } else if (path.endsWith('.json')) {
    return 'application/json';
  } else if (path.endsWith('.xml')) {
    return 'application/xml';
  }
  return null;
}

// Proxy for Notion assets with underscore prefix
app.get('/_assets/*', async (req, res) => {
  const assetPath = req.path;
  const notionAssetUrl = `https://www.notion.so${assetPath}`;
  
  try {
    // Check cache first if database is available
    if (usingDatabase) {
      const cached = await getCachedAsset(notionAssetUrl);
      if (cached) {
        console.log(`Cache HIT: ${assetPath}`);
        
        // Set content type
        if (cached.contentType) {
          res.set('Content-Type', cached.contentType);
        }
        
        // Set cached headers
        if (cached.headers) {
          Object.entries(cached.headers).forEach(([key, value]) => {
            if (key !== 'content-encoding' && key !== 'content-length') {
              res.set(key, value);
            }
          });
        }
        
        // Add cache hit header
        res.set('X-Cache', 'HIT');
        
        return res.send(cached.content);
      }
    }
    
    console.log(`Cache MISS: ${assetPath}`);
    
    const response = await fetch(notionAssetUrl);
    
    if (!response.ok) {
      return res.status(response.status).send(`Asset not found: ${response.statusText}`);
    }
    
    // Pass through the content type from the original response
    let contentType = response.headers.get('content-type');
    
    // Only override if the content type is clearly wrong (text/html for JS/CSS files)
    if (contentType === 'text/html' || contentType === 'text/plain') {
      const detectedType = getMimeType(assetPath);
      if (detectedType) {
        console.log(`Overriding incorrect MIME type ${contentType} with ${detectedType} for ${assetPath}`);
        contentType = detectedType;
      }
    }
    
    // Collect headers to pass through and save
    const headersToSave = {};
    const headersToPass = [
      'cache-control',
      'etag',
      'last-modified',
      'expires',
      'vary',
      'access-control-allow-origin',
      'access-control-allow-methods',
      'access-control-allow-headers'
    ];
    
    headersToPass.forEach(header => {
      const value = response.headers.get(header);
      if (value) {
        headersToSave[header] = value;
        res.set(header, value);
      }
    });
    
    // Set content type
    if (contentType) {
      res.set('Content-Type', contentType);
    }
    
    // Add cache miss header
    res.set('X-Cache', 'MISS');
    
    // Stream the response - buffer() automatically handles decompression
    const buffer = await response.buffer();
    
    // Cache the asset if database is available
    if (usingDatabase) {
      await setCachedAsset(notionAssetUrl, contentType, buffer, headersToSave);
      console.log(`Cached asset: ${assetPath}`);
    }
    
    res.send(buffer);
  } catch (error) {
    console.error('Error fetching asset:', error);
    res.status(500).send('Error loading asset');
  }
});

// Proxy for Notion assets without underscore
app.get('/assets/*', async (req, res) => {
  const assetPath = req.path.replace('/assets/', '/_assets/');
  const notionAssetUrl = `https://www.notion.so${assetPath}`;
  
  try {
    // Check cache first if database is available
    if (usingDatabase) {
      const cached = await getCachedAsset(notionAssetUrl);
      if (cached) {
        console.log(`Cache HIT: ${req.path}`);
        
        // Set content type
        if (cached.contentType) {
          res.set('Content-Type', cached.contentType);
        }
        
        // Set cached headers
        if (cached.headers) {
          Object.entries(cached.headers).forEach(([key, value]) => {
            if (key !== 'content-encoding' && key !== 'content-length') {
              res.set(key, value);
            }
          });
        }
        
        // Add cache hit header
        res.set('X-Cache', 'HIT');
        
        return res.send(cached.content);
      }
    }
    
    console.log(`Cache MISS: ${req.path}`);
    
    const response = await fetch(notionAssetUrl);
    
    if (!response.ok) {
      return res.status(response.status).send(`Asset not found: ${response.statusText}`);
    }
    
    // Pass through the content type from the original response
    let contentType = response.headers.get('content-type');
    
    // Only override if the content type is clearly wrong
    if (contentType === 'text/html' || contentType === 'text/plain') {
      const detectedType = getMimeType(req.path);
      if (detectedType) {
        console.log(`Overriding incorrect MIME type ${contentType} with ${detectedType} for ${req.path}`);
        contentType = detectedType;
      }
    }
    
    // Collect headers to save
    const headersToSave = {};
    const headersToPass = [
      'cache-control',
      'etag',
      'last-modified',
      'expires',
      'vary',
      'access-control-allow-origin',
      'access-control-allow-methods',
      'access-control-allow-headers'
    ];
    
    headersToPass.forEach(header => {
      const value = response.headers.get(header);
      if (value) {
        headersToSave[header] = value;
        res.set(header, value);
      }
    });
    
    // Set content type
    if (contentType) {
      res.set('Content-Type', contentType);
    }
    
    // Add cache miss header
    res.set('X-Cache', 'MISS');
    
    // Stream the response - buffer() automatically handles decompression
    const buffer = await response.buffer();
    
    // Cache the asset if database is available
    if (usingDatabase) {
      await setCachedAsset(notionAssetUrl, contentType, buffer, headersToSave);
      console.log(`Cached asset: ${req.path}`);
    }
    
    res.send(buffer);
  } catch (error) {
    console.error('Error fetching asset:', error);
    res.status(500).send('Error loading asset');
  }
});

// Proxy for external Notion CDN assets
app.get('/proxy/asset', async (req, res) => {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).send('URL parameter required');
  }
  
  try {
    // Decode the URL
    const assetUrl = decodeURIComponent(url);
    
    // Only allow specific CDN domains for security
    const allowedDomains = [
      'amazonaws.com',
      'notion.so',
      'notion.site',
      'notion.com'
    ];
    
    const urlObj = new URL(assetUrl);
    if (!allowedDomains.some(domain => urlObj.hostname.includes(domain))) {
      return res.status(403).send('Domain not allowed');
    }
    
    // Check cache first if database is available
    if (usingDatabase) {
      const cached = await getCachedAsset(assetUrl);
      if (cached) {
        console.log(`Cache HIT: External asset`);
        
        // Set content type
        if (cached.contentType) {
          res.set('Content-Type', cached.contentType);
        }
        
        // Set cached headers
        if (cached.headers) {
          Object.entries(cached.headers).forEach(([key, value]) => {
            if (key !== 'content-encoding' && key !== 'content-length') {
              res.set(key, value);
            }
          });
        }
        
        // Add cache hit header
        res.set('X-Cache', 'HIT');
        
        return res.send(cached.content);
      }
    }
    
    console.log(`Cache MISS: External asset`);
    
    const response = await fetch(assetUrl);
    
    if (!response.ok) {
      return res.status(response.status).send(`Asset not found: ${response.statusText}`);
    }
    
    // Pass through the content type from the original response
    let contentType = response.headers.get('content-type');
    
    // Only override if the content type is clearly wrong
    if (contentType === 'text/html' || contentType === 'text/plain') {
      const detectedType = getMimeType(assetUrl);
      if (detectedType) {
        console.log(`Overriding incorrect MIME type ${contentType} with ${detectedType} for external asset`);
        contentType = detectedType;
      }
    }
    
    // Collect headers to save
    const headersToSave = {};
    const headersToPass = [
      'cache-control',
      'etag',
      'last-modified',
      'expires',
      'vary'
    ];
    
    headersToPass.forEach(header => {
      const value = response.headers.get(header);
      if (value) {
        headersToSave[header] = value;
        res.set(header, value);
      }
    });
    
    // Set content type
    if (contentType) {
      res.set('Content-Type', contentType);
    }
    
    // Add cache miss header
    res.set('X-Cache', 'MISS');
    
    // Stream the response - buffer() automatically handles decompression
    const buffer = await response.buffer();
    
    // Cache the asset if database is available
    if (usingDatabase) {
      await setCachedAsset(assetUrl, contentType, buffer, headersToSave);
      console.log(`Cached external asset`);
    }
    
    res.send(buffer);
  } catch (error) {
    console.error('Error fetching external asset:', error);
    res.status(500).send('Error loading asset');
  }
});

// Legacy proxy endpoint with obfuscated URL (kept for backward compatibility)
app.get('/p/:id', async (req, res) => {
  const { id } = req.params;
  
  let notionUrl;
  if (usingDatabase) {
    notionUrl = await getMapping(id);
  } else {
    notionUrl = fallbackUrlMap.get(id);
  }
  
  if (!notionUrl) {
    return res.status(404).send('Page not found');
  }
  
  // Record page view tracking
  if (usingDatabase) {
    await recordTracking(id, 'page', {
      userAgent: req.get('user-agent'),
      ip: req.ip || req.connection.remoteAddress,
      referer: req.get('referer'),
      pageId: id
    });
  }
  
  return proxyNotionPage(notionUrl, req, res);
});

// List all registered URLs
app.get('/list', async (req, res) => {
  let entries = [];
  
  if (usingDatabase) {
    const mappings = await getAllMappings();
    entries = mappings.map(row => ({
      id: row.id,
      notionUrl: row.notion_url,
      path: row.path || null,
      isRoot: row.is_root || false,
      legacyUrl: `${req.protocol}://${req.get('host')}/p/${row.id}`,
      transparentUrl: row.path ? `${req.protocol}://${req.get('host')}${row.path}` : null,
      created: row.created_at,
      accessCount: row.access_count,
      lastAccessed: row.last_accessed
    }));
  } else {
    entries = Array.from(fallbackUrlMap.entries()).map(([id, url]) => ({
      id,
      notionUrl: url,
      proxyUrl: `${req.protocol}://${req.get('host')}/p/${id}`
    }));
  }
  
  res.json({
    usingDatabase,
    count: entries.length,
    entries
  });
});

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    uptime: process.uptime(),
    usingDatabase,
    mappingsCount: usingDatabase ? 'check /list endpoint' : fallbackUrlMap.size
  });
});

// Cache statistics endpoint
app.get('/cache/stats', async (req, res) => {
  if (!usingDatabase) {
    return res.json({ 
      message: 'Cache not available without database',
      usingDatabase: false 
    });
  }
  
  const stats = await getCacheStats();
  if (stats) {
    res.json({
      totalCached: parseInt(stats.total_cached) || 0,
      totalHits: parseInt(stats.total_hits) || 0,
      totalSizeBytes: parseInt(stats.total_size) || 0,
      totalSizeMB: ((parseInt(stats.total_size) || 0) / (1024 * 1024)).toFixed(2),
      oldestCache: stats.oldest_cache,
      newestCache: stats.newest_cache,
      cacheMaxAge: '5 minutes'
    });
  } else {
    res.status(500).json({ error: 'Failed to get cache stats' });
  }
});

// Clear cache endpoint (protected with simple auth if CACHE_ADMIN_KEY is set)
app.post('/cache/clear', async (req, res) => {
  // Simple auth check if CACHE_ADMIN_KEY is configured
  const adminKey = process.env.CACHE_ADMIN_KEY;
  if (adminKey) {
    const providedKey = req.headers['x-admin-key'] || req.query.key;
    if (providedKey !== adminKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  
  if (!usingDatabase) {
    return res.json({ 
      message: 'Cache not available without database',
      usingDatabase: false 
    });
  }
  
  const clearedCount = await clearCache();
  res.json({ 
    message: 'Cache cleared',
    entriesCleared: clearedCount 
  });
});

// Root endpoint - redirect to root page if configured, otherwise show info
// Helper function to proxy a Notion page
async function proxyNotionPage(notionUrl, req, res) {
  // Check cache first for HTML content
  if (usingDatabase) {
    const cached = await getCachedAsset(notionUrl);
    if (cached) {
      res.set('X-Cache', 'HIT');
      res.set('Content-Type', cached.contentType || 'text/html');
      return res.send(cached.content);
    }
  }
  res.set('X-Cache', 'MISS');

  try {
    console.log(`Fetching Notion page: ${notionUrl}`);
    const response = await fetch(notionUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    if (!response.ok) {
      return res.status(response.status).send(`Failed to fetch page: ${response.statusText}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    
    // Remove any existing Notion analytics or tracking
    $('script[src*="analytics"]').remove();
    $('script[src*="gtag"]').remove();
    $('script[src*="segment"]').remove();
    
    // Rewrite all Notion asset URLs to use our proxy
    $('script[src], link[href]').each((i, elem) => {
      const $elem = $(elem);
      const attrName = elem.name === 'script' ? 'src' : 'href';
      const originalUrl = $elem.attr(attrName);
      
      if (originalUrl) {
        // Handle different Notion asset URL patterns
        if (originalUrl.startsWith('https://www.notion.so/_assets/')) {
          const assetPath = originalUrl.replace('https://www.notion.so/_assets/', '');
          $elem.attr(attrName, `/_assets/${assetPath}`);
        } else if (originalUrl.includes('notion.site/assets/')) {
          const match = originalUrl.match(/notion\.site\/assets\/(.+)/);
          if (match) {
            $elem.attr(attrName, `/assets/${match[1]}`);
          }
        } else if (originalUrl.includes('amazonaws.com')) {
          // Proxy S3 assets through our /proxy/asset endpoint
          $elem.attr(attrName, `/proxy/asset?url=${encodeURIComponent(originalUrl)}`);
        }
        // Relative URLs starting with / are now handled by the catch-all route
        // No need to rewrite them
      }
    });
    
    // Also handle img src attributes
    $('img[src]').each((i, elem) => {
      const $elem = $(elem);
      const originalUrl = $elem.attr('src');
      
      if (originalUrl && (originalUrl.includes('amazonaws.com') || originalUrl.includes('notion.so'))) {
        $elem.attr('src', `/proxy/asset?url=${encodeURIComponent(originalUrl)}`);
      }
    });
    
    // Add custom head snippets
    if (headConfig) {
      // Add global snippets
      if (headConfig.globalSnippets && headConfig.globalSnippets.length > 0) {
        const globalSnippet = headConfig.globalSnippets.join('\n');
        $('head').append(globalSnippet);
      }
      
      // Add page-specific snippets if available
      const pageId = req.params.id || req.path;
      if (headConfig.pageSpecificSnippets && headConfig.pageSpecificSnippets[pageId]) {
        const pageSnippet = headConfig.pageSpecificSnippets[pageId].join('\n');
        $('head').append(pageSnippet);
      }
    }
    
    const modifiedHtml = $.html();
    res.send(modifiedHtml);
    
    // Cache the modified HTML if database is available
    if (usingDatabase) {
      await setCachedAsset(notionUrl, 'text/html', Buffer.from(modifiedHtml), { 'content-type': 'text/html' });
      console.log(`Cached HTML for: ${notionUrl}`);
    }
  } catch (error) {
    console.error('Error fetching Notion page:', error);
    res.status(500).send('Error loading page');
  }
}

// Root route - proxy the configured root page
app.get('/', async (req, res) => {
  if (usingDatabase) {
    const rootMapping = await getRootMapping();
    if (rootMapping) {
      return proxyNotionPage(rootMapping.notion_url, req, res);
    }
  }
  
  // Fallback for in-memory mode or no root mapping
  const rootPage = process.env.ROOT_NOTION_PAGE;
  if (rootPage) {
    return proxyNotionPage(rootPage, req, res);
  }
  
  // Default info response if no root page configured
  res.json({
    service: 'Notion Proxy',
    endpoints: {
      'GET /*': 'Access proxied Notion pages by path',
      'GET /p/:id': 'Legacy: Access proxied Notion page by ID',
      'POST /register': 'Register a Notion URL with optional path',
      'GET /list': 'List all registered URLs',
      'GET /health': 'Health check',
      'GET /cache/stats': 'View cache statistics',
      'POST /cache/clear': 'Clear the cache'
    },
    database: usingDatabase ? 'PostgreSQL' : 'In-memory (not persistent)',
    rootPage: rootPage ? 'Not configured' : 'Not configured'
  });
});

// Tracking pixel endpoint
app.get('/pixel/:name', async (req, res) => {
  const { name } = req.params;
  const timestamp = new Date().toISOString();
  
  // Record email open
  if (usingDatabase) {
    await recordTracking(name, 'email', {
      userAgent: req.get('user-agent'),
      ip: req.ip || req.connection.remoteAddress,
      referer: req.get('referer')
    });
  } else {
    // Fallback tracking
    if (!fallbackTracking.has(name)) {
      fallbackTracking.set(name, { email: [] });
    }
    const tracking = fallbackTracking.get(name);
    if (!tracking.email) tracking.email = [];
    tracking.email.push({
      timestamp,
      userAgent: req.get('user-agent'),
      ip: req.ip || req.connection.remoteAddress,
      referer: req.get('referer')
    });
  }
  
  console.log(`Email pixel opened: ${name} at ${timestamp}`);
  
  // Return a transparent 1x1 pixel GIF
  const pixel = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
  );
  
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': pixel.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  
  res.end(pixel);
});

// Catch-all route for transparent path-based routing
app.get('/*', async (req, res) => {
  const path = req.path;
  
  // Skip API and asset routes
  if (path.startsWith('/_assets/') || 
      path.startsWith('/assets/') || 
      path.startsWith('/proxy/') ||
      path.startsWith('/p/') ||
      path.startsWith('/pixel/') ||
      path === '/list' ||
      path === '/health' ||
      path === '/cache' ||
      path === '/register') {
    return res.status(404).send('Not found');
  }
  
  // Check if this is a static asset (CSS, JS, JSON, images, fonts, etc.)
  const mimeType = getMimeType(path);
  if (mimeType) {
    // Proxy static assets directly to Notion
    const notionAssetUrl = `https://www.notion.so${path}`;
    
    try {
      // Check cache first if database is available
      if (usingDatabase) {
        const cached = await getCachedAsset(notionAssetUrl);
        if (cached) {
          console.log(`Cache HIT: ${path}`);
          res.set('Content-Type', cached.contentType || mimeType);
          res.set('X-Cache', 'HIT');
          return res.send(cached.content);
        }
      }
      
      console.log(`Cache MISS: ${path} - Proxying to Notion`);
      const response = await fetch(notionAssetUrl);
      
      if (!response.ok) {
        return res.status(response.status).send(`Asset not found: ${response.statusText}`);
      }
      
      const buffer = await response.buffer();
      res.set('Content-Type', mimeType);
      res.set('X-Cache', 'MISS');
      res.set('Cache-Control', 'public, max-age=300');
      res.send(buffer);
      
      // Cache the asset if database is available
      if (usingDatabase) {
        await setCachedAsset(notionAssetUrl, mimeType, buffer, { 'content-type': mimeType });
        console.log(`Cached asset: ${path}`);
      }
    } catch (error) {
      console.error(`Error proxying asset ${path}:`, error);
      return res.status(500).send('Error loading asset');
    }
    return;
  }
  
  // For non-static assets (HTML pages), check database mappings
  if (usingDatabase) {
    const mapping = await getMappingByPath(path);
    if (mapping) {
      return proxyNotionPage(mapping.notion_url, req, res);
    }
  }
  
  // No mapping found
  res.status(404).send('Page not found');
});

// Start server
app.listen(PORT, async () => {
  await initialize();
  console.log(`Notion proxy server running on http://localhost:${PORT}`);
  console.log(`Storage mode: ${usingDatabase ? 'PostgreSQL Database' : 'In-memory (not persistent)'}`);
  
  if (process.env.ROOT_NOTION_PAGE) {
    console.log(`Root page configured: ${process.env.ROOT_NOTION_PAGE}`);
    console.log(`Visit http://localhost:${PORT}/ to view your Notion site`);
  }
  
  console.log('\nTracking:');
  console.log('GET /pixel/:name - Email tracking pixel');
  console.log('Page views automatically tracked on /p/:id');
});