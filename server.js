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
  recordTracking
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
  const { notionUrl } = req.body;
  
  if (!notionUrl) {
    return res.status(400).json({ error: 'notionUrl is required' });
  }
  
  let id;
  if (usingDatabase) {
    id = await createMapping(notionUrl);
    if (!id) {
      return res.status(500).json({ error: 'Failed to create mapping' });
    }
  } else {
    id = Math.random().toString(36).substring(2, 12);
    fallbackUrlMap.set(id, notionUrl);
  }
  
  res.json({ 
    id,
    proxyUrl: `${req.protocol}://${req.get('host')}/p/${id}`
  });
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
    
    // Pass through all relevant headers from the original response
    const headersToPass = [
      'content-type',
      'content-length',
      'content-encoding',
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
        // Special handling for content-type if we overrode it
        if (header === 'content-type' && contentType !== response.headers.get('content-type')) {
          res.set(header, contentType);
        } else {
          res.set(header, value);
        }
      }
    });
    
    // Stream the response
    const buffer = await response.buffer();
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
    
    // Pass through all relevant headers from the original response
    const headersToPass = [
      'content-type',
      'content-length',
      'content-encoding',
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
        // Special handling for content-type if we overrode it
        if (header === 'content-type' && contentType !== response.headers.get('content-type')) {
          res.set(header, contentType);
        } else {
          res.set(header, value);
        }
      }
    });
    
    // Stream the response
    const buffer = await response.buffer();
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
    
    // Pass through all relevant headers from the original response
    const headersToPass = [
      'content-type',
      'content-length',
      'content-encoding',
      'cache-control',
      'etag',
      'last-modified',
      'expires',
      'vary'
    ];
    
    headersToPass.forEach(header => {
      const value = response.headers.get(header);
      if (value) {
        // Special handling for content-type if we overrode it
        if (header === 'content-type' && contentType !== response.headers.get('content-type')) {
          res.set(header, contentType);
        } else {
          res.set(header, value);
        }
      }
    });
    
    // Stream the response
    const buffer = await response.buffer();
    res.send(buffer);
  } catch (error) {
    console.error('Error fetching external asset:', error);
    res.status(500).send('Error loading asset');
  }
});

// Proxy endpoint with obfuscated URL
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
  } else {
    // Fallback tracking
    if (!fallbackTracking.has(id)) {
      fallbackTracking.set(id, { page: [] });
    }
    const tracking = fallbackTracking.get(id);
    if (!tracking.page) tracking.page = [];
    tracking.page.push({
      timestamp: new Date().toISOString(),
      userAgent: req.get('user-agent'),
      ip: req.ip || req.connection.remoteAddress,
      referer: req.get('referer')
    });
  }
  
  try {
    // Fetch the Notion page
    const response = await fetch(notionUrl);
    const html = await response.text();
    
    // Parse HTML with Cheerio
    const $ = cheerio.load(html);
    
    // Rewrite asset URLs to use our proxy
    // Handle script tags
    $('script[src]').each((i, elem) => {
      const src = $(elem).attr('src');
      if (src) {
        if (src.includes('notion.so/_assets/') || src.includes('notion.site/_assets/')) {
          // Extract just the _assets path
          const assetPath = src.substring(src.indexOf('/_assets/'));
          $(elem).attr('src', assetPath);
        } else if (src.includes('notion.so/assets/') || src.includes('notion.site/assets/')) {
          // Extract just the assets path (without underscore)
          const assetPath = src.substring(src.indexOf('/assets/'));
          $(elem).attr('src', assetPath);
        } else if (src.startsWith('https://') && (src.includes('amazonaws.com') || src.includes('notion'))) {
          // Proxy external CDN assets
          $(elem).attr('src', `/proxy/asset?url=${encodeURIComponent(src)}`);
        } else if (src.startsWith('/_assets/') || src.startsWith('/assets/')) {
          // Already relative, leave as is
        }
      }
    });
    
    // Handle link tags (CSS)
    $('link[href]').each((i, elem) => {
      const href = $(elem).attr('href');
      if (href) {
        if (href.includes('notion.so/_assets/') || href.includes('notion.site/_assets/')) {
          // Extract just the _assets path
          const assetPath = href.substring(href.indexOf('/_assets/'));
          $(elem).attr('href', assetPath);
        } else if (href.includes('notion.so/assets/') || href.includes('notion.site/assets/')) {
          // Extract just the assets path (without underscore)
          const assetPath = href.substring(href.indexOf('/assets/'));
          $(elem).attr('href', assetPath);
        } else if (href.startsWith('https://') && (href.includes('amazonaws.com') || href.includes('notion'))) {
          // Proxy external CDN assets
          $(elem).attr('href', `/proxy/asset?url=${encodeURIComponent(href)}`);
        } else if (href.startsWith('/_assets/') || href.startsWith('/assets/')) {
          // Already relative, leave as is
        }
      }
    });
    
    // Handle image tags
    $('img[src]').each((i, elem) => {
      const src = $(elem).attr('src');
      if (src) {
        if (src.includes('notion.so/_assets/') || src.includes('notion.site/_assets/')) {
          // Extract just the _assets path
          const assetPath = src.substring(src.indexOf('/_assets/'));
          $(elem).attr('src', assetPath);
        } else if (src.includes('notion.so/assets/') || src.includes('notion.site/assets/')) {
          // Extract just the assets path (without underscore)
          const assetPath = src.substring(src.indexOf('/assets/'));
          $(elem).attr('src', assetPath);
        } else if (src.startsWith('https://') && (src.includes('amazonaws.com') || src.includes('notion'))) {
          // Proxy external CDN assets
          $(elem).attr('src', `/proxy/asset?url=${encodeURIComponent(src)}`);
        } else if (src.startsWith('/_assets/') || src.startsWith('/assets/')) {
          // Already relative, leave as is
        }
      }
    });
    
    // Handle inline styles with url() references
    $('[style]').each((i, elem) => {
      const style = $(elem).attr('style');
      if (style && style.includes('url(')) {
        let newStyle = style;
        // Match url() patterns
        const urlMatches = style.match(/url\(['"]?(https?:\/\/[^'"\)]+)['"]?\)/g);
        if (urlMatches) {
          urlMatches.forEach(match => {
            const url = match.match(/url\(['"]?(https?:\/\/[^'"\)]+)['"]?\)/)[1];
            if (url && (url.includes('amazonaws.com') || url.includes('notion'))) {
              newStyle = newStyle.replace(match, `url('/proxy/asset?url=${encodeURIComponent(url)}')`);
            }
          });
          $(elem).attr('style', newStyle);
        }
      }
    });
    
    // Auto-discover and register linked Notion pages
    if (process.env.AUTO_DISCOVER_LINKS === 'true') {
      const notionLinks = new Set();
      
      // Find all Notion links
      $('a[href*="notion.so"], a[href*="notion.site"]').each((i, elem) => {
        const href = $(elem).attr('href');
        if (href && (href.includes('notion.so') || href.includes('notion.site'))) {
          // Clean up the URL
          const cleanUrl = href.split('?')[0].split('#')[0];
          notionLinks.add(cleanUrl);
        }
      });
      
      // Register discovered links
      for (const link of notionLinks) {
        if (usingDatabase) {
          const existingMappings = await getAllMappings();
          const exists = existingMappings.some(m => m.notion_url === link);
          if (!exists) {
            const newId = await createMapping(link);
            if (newId) {
              console.log(`Auto-discovered link: ${link} -> ${newId}`);
              // Replace the link in the HTML
              const newProxyUrl = `/p/${newId}`;
              $(`a[href="${link}"]`).attr('href', newProxyUrl);
            }
          } else {
            // Replace with existing proxy URL
            const existing = existingMappings.find(m => m.notion_url === link);
            if (existing) {
              $(`a[href="${link}"]`).attr('href', `/p/${existing.id}`);
            }
          }
        }
      }
    }
    
    // Add global snippets to HEAD
    headConfig.globalSnippets?.forEach(snippet => {
      $('head').append(snippet);
    });
    
    // Add page-specific snippets if configured
    const pageSnippets = headConfig.pageSpecificSnippets?.[id];
    if (pageSnippets) {
      pageSnippets.forEach(snippet => {
        $('head').append(snippet);
      });
    }
    
    // Send modified HTML
    res.send($.html());
  } catch (error) {
    console.error('Error fetching Notion page:', error);
    res.status(500).send('Error loading page');
  }
});

// List all registered URLs
app.get('/list', async (req, res) => {
  let entries = [];
  
  if (usingDatabase) {
    const mappings = await getAllMappings();
    entries = mappings.map(row => ({
      id: row.id,
      notionUrl: row.notion_url,
      proxyUrl: `${req.protocol}://${req.get('host')}/p/${row.id}`,
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

// Root endpoint - redirect to root page if configured, otherwise show info
app.get('/', async (req, res) => {
  // Check if ROOT_NOTION_PAGE is configured
  const rootPage = process.env.ROOT_NOTION_PAGE;
  
  if (rootPage) {
    // Check if this page is already registered
    let rootId = null;
    
    if (usingDatabase) {
      const mappings = await getAllMappings();
      const existing = mappings.find(m => m.notion_url === rootPage);
      if (existing) {
        rootId = existing.id;
      } else {
        // Register the root page
        rootId = await createMapping(rootPage);
        console.log(`Registered root page: ${rootPage} -> ${rootId}`);
      }
    } else {
      // Check in-memory map
      const existing = Array.from(fallbackUrlMap.entries()).find(([_, url]) => url === rootPage);
      if (existing) {
        rootId = existing[0];
      } else {
        // Register in memory
        rootId = Math.random().toString(36).substring(2, 12);
        fallbackUrlMap.set(rootId, rootPage);
        console.log(`Registered root page (memory): ${rootPage} -> ${rootId}`);
      }
    }
    
    if (rootId) {
      // Redirect to the proxied root page
      return res.redirect(`/p/${rootId}`);
    }
  }
  
  // Default info response if no root page configured
  res.json({
    service: 'Notion Proxy',
    endpoints: {
      'GET /p/:id': 'Access proxied Notion page',
      'POST /register': 'Register a Notion URL',
      'GET /list': 'List all registered URLs',
      'GET /health': 'Health check'
    },
    database: usingDatabase ? 'PostgreSQL' : 'In-memory (not persistent)',
    rootPage: rootPage ? 'Configured (redirecting...)' : 'Not configured'
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