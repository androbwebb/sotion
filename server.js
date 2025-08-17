import express from 'express';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { nanoid } from 'nanoid';
import { readFileSync } from 'fs';

const app = express();
const PORT = process.env.PORT || 3000;

// Store mapping of obfuscated IDs to actual Notion URLs
const urlMap = new Map();

// Load config for HEAD snippets
let headConfig = {};
try {
  headConfig = JSON.parse(readFileSync('./config.json', 'utf8'));
} catch (e) {
  console.log('No config.json found, using defaults');
  headConfig = {
    globalSnippets: [],
    pageSpecificSnippets: {}
  };
}

app.use(express.json());

// Endpoint to register a new Notion page and get obfuscated URL
app.post('/register', (req, res) => {
  const { notionUrl } = req.body;
  
  if (!notionUrl) {
    return res.status(400).json({ error: 'notionUrl is required' });
  }
  
  const id = nanoid(10);
  urlMap.set(id, notionUrl);
  
  res.json({ 
    id,
    proxyUrl: `${req.protocol}://${req.get('host')}/p/${id}`
  });
});

// Proxy endpoint with obfuscated URL
app.get('/p/:id', async (req, res) => {
  const { id } = req.params;
  const notionUrl = urlMap.get(id);
  
  if (!notionUrl) {
    return res.status(404).send('Page not found');
  }
  
  try {
    // Fetch the Notion page
    const response = await fetch(notionUrl);
    const html = await response.text();
    
    // Parse HTML with Cheerio
    const $ = cheerio.load(html);
    
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
    
    // Update any absolute Notion URLs to go through our proxy
    $('a[href^="https://www.notion.so"]').each((i, elem) => {
      const href = $(elem).attr('href');
      // You could auto-register these URLs and replace them
      // For now, just leaving them as-is
    });
    
    // Send modified HTML
    res.send($.html());
  } catch (error) {
    console.error('Error fetching Notion page:', error);
    res.status(500).send('Error loading page');
  }
});

// Endpoint to update HEAD snippets configuration
app.post('/config', (req, res) => {
  const { globalSnippets, pageSpecificSnippets } = req.body;
  
  if (globalSnippets) {
    headConfig.globalSnippets = globalSnippets;
  }
  
  if (pageSpecificSnippets) {
    headConfig.pageSpecificSnippets = {
      ...headConfig.pageSpecificSnippets,
      ...pageSpecificSnippets
    };
  }
  
  // Save to config file
  try {
    const fs = await import('fs');
    fs.writeFileSync('./config.json', JSON.stringify(headConfig, null, 2));
    res.json({ success: true, config: headConfig });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save config' });
  }
});

// List all registered URLs
app.get('/list', (req, res) => {
  const entries = Array.from(urlMap.entries()).map(([id, url]) => ({
    id,
    notionUrl: url,
    proxyUrl: `${req.protocol}://${req.get('host')}/p/${id}`
  }));
  
  res.json(entries);
});

app.listen(PORT, () => {
  console.log(`Notion proxy server running on http://localhost:${PORT}`);
  console.log('\nEndpoints:');
  console.log('POST /register - Register a Notion URL and get obfuscated proxy URL');
  console.log('GET /p/:id - Access proxied Notion page');
  console.log('POST /config - Update HEAD snippet configuration');
  console.log('GET /list - List all registered URLs');
});