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
  autoDiscoverFromEnv
} from './database.js';
import { initNotionClient, autoDiscoverViaAPI } from './notion-api.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Fallback in-memory storage if database is not available
const fallbackUrlMap = new Map();
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
  
  try {
    // Fetch the Notion page
    const response = await fetch(notionUrl);
    const html = await response.text();
    
    // Parse HTML with Cheerio
    const $ = cheerio.load(html);
    
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

// Start server
app.listen(PORT, async () => {
  await initialize();
  console.log(`Notion proxy server running on http://localhost:${PORT}`);
  console.log(`Storage mode: ${usingDatabase ? 'PostgreSQL Database' : 'In-memory (not persistent)'}`);
  
  if (process.env.ROOT_NOTION_PAGE) {
    console.log(`Root page configured: ${process.env.ROOT_NOTION_PAGE}`);
    console.log(`Visit http://localhost:${PORT}/ to view your Notion site`);
  }
});