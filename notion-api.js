import { Client } from '@notionhq/client';
import { createMapping } from './database.js';

let notion = null;

export function initNotionClient() {
  if (process.env.NOTION_TOKEN) {
    notion = new Client({
      auth: process.env.NOTION_TOKEN,
    });
    console.log('Notion API client initialized');
    return true;
  }
  console.log('No NOTION_TOKEN found, Notion API features disabled');
  return false;
}

// Convert Notion API page ID to public URL
function pageIdToUrl(pageId) {
  const cleanId = pageId.replace(/-/g, '');
  return `https://www.notion.so/${cleanId}`;
}

// Discover all pages in workspace
export async function discoverWorkspacePages() {
  if (!notion) return [];
  
  try {
    console.log('Discovering workspace pages via Notion API...');
    const response = await notion.search({
      filter: {
        property: 'object',
        value: 'page'
      },
      page_size: 100
    });
    
    const pages = [];
    for (const page of response.results) {
      if (page.object === 'page') {
        const url = pageIdToUrl(page.id);
        const title = page.properties?.title?.title?.[0]?.plain_text || 
                     page.properties?.Name?.title?.[0]?.plain_text || 
                     'Untitled';
        pages.push({ url, title, id: page.id });
      }
    }
    
    console.log(`Found ${pages.length} pages in workspace`);
    return pages;
  } catch (error) {
    console.error('Error discovering workspace pages:', error);
    return [];
  }
}

// Discover pages in specific databases
export async function discoverDatabasePages(databaseIds) {
  if (!notion) return [];
  
  const allPages = [];
  
  for (const dbId of databaseIds) {
    try {
      console.log(`Discovering pages in database ${dbId}...`);
      const response = await notion.databases.query({
        database_id: dbId,
        page_size: 100
      });
      
      for (const page of response.results) {
        const url = pageIdToUrl(page.id);
        const title = page.properties?.Name?.title?.[0]?.plain_text || 
                     page.properties?.title?.title?.[0]?.plain_text || 
                     'Untitled';
        allPages.push({ url, title, id: page.id });
      }
    } catch (error) {
      console.error(`Error querying database ${dbId}:`, error);
    }
  }
  
  console.log(`Found ${allPages.length} pages across databases`);
  return allPages;
}

// Auto-discover and register pages
export async function autoDiscoverViaAPI() {
  if (!notion) return;
  
  try {
    // Discover workspace pages if enabled
    if (process.env.NOTION_DISCOVER_WORKSPACE === 'true') {
      const workspacePages = await discoverWorkspacePages();
      for (const page of workspacePages) {
        const id = await createMapping(page.url);
        if (id) {
          console.log(`Auto-registered via API: ${page.title} -> ${id}`);
        }
      }
    }
    
    // Discover database pages if database IDs provided
    if (process.env.NOTION_DATABASE_IDS) {
      const dbIds = process.env.NOTION_DATABASE_IDS.split(',').map(id => id.trim());
      const dbPages = await discoverDatabasePages(dbIds);
      for (const page of dbPages) {
        const id = await createMapping(page.url);
        if (id) {
          console.log(`Auto-registered from database: ${page.title} -> ${id}`);
        }
      }
    }
  } catch (error) {
    console.error('Error in auto-discovery via API:', error);
  }
}

export default notion;