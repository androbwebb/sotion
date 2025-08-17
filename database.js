import pg from 'pg';
import { nanoid } from 'nanoid';
import { runMigrations, getMigrationStatus } from './migrations.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

export async function initDatabase() {
  try {
    // Check migration status
    const status = await getMigrationStatus(pool);
    console.log('Migration status:', {
      initialized: status.initialized,
      applied: status.applied?.length || 0,
      pending: status.pending?.length || 0
    });
    
    // Run any pending migrations
    const migrationsRun = await runMigrations(pool);
    
    if (migrationsRun > 0) {
      console.log(`Database updated with ${migrationsRun} migrations`);
    } else {
      console.log('Database schema is up to date');
    }
    
    return true;
  } catch (error) {
    console.error('Database initialization error:', error);
    console.log('Running in fallback mode without database');
    throw error;
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

// Asset cache functions
export async function getCachedAsset(url) {
  try {
    // First clean up expired entries
    await pool.query('DELETE FROM asset_cache WHERE expires_at < CURRENT_TIMESTAMP');
    
    const result = await pool.query(
      `SELECT content_type, content, headers 
       FROM asset_cache 
       WHERE url = $1 AND expires_at > CURRENT_TIMESTAMP`,
      [url]
    );
    
    if (result.rows.length > 0) {
      // Update hit count
      await pool.query(
        'UPDATE asset_cache SET hit_count = hit_count + 1 WHERE url = $1',
        [url]
      );
      
      return {
        contentType: result.rows[0].content_type,
        content: result.rows[0].content,
        headers: result.rows[0].headers,
        cached: true
      };
    }
    
    return null;
  } catch (error) {
    console.error('Error getting cached asset:', error);
    return null;
  }
}

export async function setCachedAsset(url, contentType, content, headers) {
  try {
    await pool.query(
      `INSERT INTO asset_cache (url, content_type, content, headers, expires_at) 
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes')
       ON CONFLICT (url) DO UPDATE SET 
         content_type = $2,
         content = $3,
         headers = $4,
         cached_at = CURRENT_TIMESTAMP,
         expires_at = CURRENT_TIMESTAMP + INTERVAL '5 minutes'`,
      [url, contentType, content, JSON.stringify(headers)]
    );
    
    return true;
  } catch (error) {
    console.error('Error caching asset:', error);
    return false;
  }
}

export async function getCacheStats() {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_cached,
        SUM(hit_count) as total_hits,
        SUM(LENGTH(content)) as total_size,
        MIN(cached_at) as oldest_cache,
        MAX(cached_at) as newest_cache
      FROM asset_cache
      WHERE expires_at > CURRENT_TIMESTAMP
    `);
    
    return stats.rows[0];
  } catch (error) {
    console.error('Error getting cache stats:', error);
    return null;
  }
}

export async function clearCache() {
  try {
    const result = await pool.query('DELETE FROM asset_cache');
    return result.rowCount;
  } catch (error) {
    console.error('Error clearing cache:', error);
    return 0;
  }
}

export default pool;