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
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tracking (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(10) NOT NULL CHECK (type IN ('email', 'page')),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        user_agent TEXT,
        ip VARCHAR(45),
        referer TEXT,
        page_id VARCHAR(10),
        FOREIGN KEY (page_id) REFERENCES url_mappings(id) ON DELETE CASCADE
      )
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_tracking_name ON tracking(name);
      CREATE INDEX IF NOT EXISTS idx_tracking_type ON tracking(type);
      CREATE INDEX IF NOT EXISTS idx_tracking_timestamp ON tracking(timestamp);
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

export async function recordTracking(name, type, { userAgent, ip, referer, pageId } = {}) {
  try {
    await pool.query(
      `INSERT INTO tracking (name, type, user_agent, ip, referer, page_id) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [name, type, userAgent, ip, referer, pageId]
    );
    return true;
  } catch (error) {
    console.error('Error recording tracking:', error);
    return false;
  }
}

export async function getTrackingStats(name = null) {
  try {
    let query;
    let params;
    
    if (name) {
      query = `
        SELECT 
          name,
          type,
          MIN(timestamp) as first_opened,
          MAX(timestamp) as last_opened,
          COUNT(*) as total_opens,
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'timestamp', timestamp,
              'type', type,
              'userAgent', user_agent,
              'ip', ip,
              'referer', referer,
              'pageId', page_id
            ) ORDER BY timestamp DESC
          ) as opens
        FROM tracking 
        WHERE name = $1
        GROUP BY name, type
      `;
      params = [name];
    } else {
      query = `
        SELECT 
          name,
          type,
          MIN(timestamp) as first_opened,
          MAX(timestamp) as last_opened,
          COUNT(*) as total_opens,
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'timestamp', timestamp,
              'type', type,
              'userAgent', user_agent,
              'ip', ip,
              'referer', referer,
              'pageId', page_id
            ) ORDER BY timestamp DESC
          ) as opens
        FROM tracking 
        GROUP BY name, type
        ORDER BY MAX(timestamp) DESC
      `;
      params = [];
    }
    
    const result = await pool.query(query, params);
    
    if (name && result.rows.length > 0) {
      // Return single record for specific name
      const row = result.rows[0];
      return {
        firstOpened: row.first_opened,
        lastOpened: row.last_opened,
        totalOpens: parseInt(row.total_opens),
        type: row.type,
        opens: row.opens
      };
    } else if (!name) {
      // Return all records grouped by name
      const stats = {};
      result.rows.forEach(row => {
        if (!stats[row.name]) {
          stats[row.name] = {};
        }
        stats[row.name][row.type] = {
          firstOpened: row.first_opened,
          lastOpened: row.last_opened,
          totalOpens: parseInt(row.total_opens),
          opens: row.opens
        };
      });
      return stats;
    }
    
    return null;
  } catch (error) {
    console.error('Error getting tracking stats:', error);
    return null;
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