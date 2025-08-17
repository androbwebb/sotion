import pg from 'pg';
import { nanoid } from 'nanoid';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

export async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS url_mappings (
        id VARCHAR(10) PRIMARY KEY,
        notion_url TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        access_count INTEGER DEFAULT 0,
        last_accessed TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS head_configs (
        id SERIAL PRIMARY KEY,
        config_type VARCHAR(20) NOT NULL,
        page_id VARCHAR(10),
        snippet TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('Database tables initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
    console.log('Running in fallback mode without database');
  }
}

export async function getAllMappings() {
  try {
    const result = await pool.query('SELECT * FROM url_mappings ORDER BY created_at DESC');
    return result.rows;
  } catch (error) {
    console.error('Error fetching mappings:', error);
    return [];
  }
}

export async function getMapping(id) {
  try {
    const result = await pool.query('SELECT notion_url FROM url_mappings WHERE id = $1', [id]);
    if (result.rows.length > 0) {
      await pool.query('UPDATE url_mappings SET access_count = access_count + 1, last_accessed = CURRENT_TIMESTAMP WHERE id = $1', [id]);
      return result.rows[0].notion_url;
    }
    return null;
  } catch (error) {
    console.error('Error getting mapping:', error);
    return null;
  }
}

export async function createMapping(notionUrl, customId = null) {
  const id = customId || nanoid(10);
  try {
    await pool.query(
      'INSERT INTO url_mappings (id, notion_url) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET notion_url = $2',
      [id, notionUrl]
    );
    return id;
  } catch (error) {
    console.error('Error creating mapping:', error);
    return null;
  }
}

export async function deleteMapping(id) {
  try {
    await pool.query('DELETE FROM url_mappings WHERE id = $1', [id]);
    return true;
  } catch (error) {
    console.error('Error deleting mapping:', error);
    return false;
  }
}

export async function getHeadConfigs() {
  try {
    const global = await pool.query("SELECT snippet FROM head_configs WHERE config_type = 'global'");
    const pageSpecific = await pool.query("SELECT page_id, snippet FROM head_configs WHERE config_type = 'page'");
    
    const pageSnippets = {};
    pageSpecific.rows.forEach(row => {
      if (!pageSnippets[row.page_id]) {
        pageSnippets[row.page_id] = [];
      }
      pageSnippets[row.page_id].push(row.snippet);
    });
    
    return {
      globalSnippets: global.rows.map(r => r.snippet),
      pageSpecificSnippets: pageSnippets
    };
  } catch (error) {
    console.error('Error getting head configs:', error);
    return { globalSnippets: [], pageSpecificSnippets: {} };
  }
}

export async function saveHeadConfigs(globalSnippets = [], pageSpecificSnippets = {}) {
  try {
    await pool.query("DELETE FROM head_configs");
    
    for (const snippet of globalSnippets) {
      await pool.query(
        "INSERT INTO head_configs (config_type, snippet) VALUES ('global', $1)",
        [snippet]
      );
    }
    
    for (const [pageId, snippets] of Object.entries(pageSpecificSnippets)) {
      for (const snippet of snippets) {
        await pool.query(
          "INSERT INTO head_configs (config_type, page_id, snippet) VALUES ('page', $1, $2)",
          [pageId, snippet]
        );
      }
    }
    
    return true;
  } catch (error) {
    console.error('Error saving head configs:', error);
    return false;
  }
}

export async function autoDiscoverFromEnv() {
  // Auto-register root page if configured
  const rootPage = process.env.ROOT_NOTION_PAGE;
  if (rootPage) {
    const id = await createMapping(rootPage);
    if (id) {
      console.log(`Auto-registered root page: ${rootPage} -> ${id}`);
    }
  }
  
  // Auto-register additional pages
  const envPages = process.env.NOTION_PAGES;
  if (envPages) {
    const urls = envPages.split(',').map(url => url.trim()).filter(Boolean);
    for (const url of urls) {
      const id = await createMapping(url);
      if (id) {
        console.log(`Auto-registered: ${url} -> ${id}`);
      }
    }
  }
}

export default pool;