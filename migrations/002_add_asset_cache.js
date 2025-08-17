export const up = async (pool) => {
  // Create asset cache table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS asset_cache (
      url TEXT PRIMARY KEY,
      content_type VARCHAR(255),
      content BYTEA,
      headers JSONB,
      cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '5 minutes'),
      hit_count INTEGER DEFAULT 0
    )
  `);
  
  // Create index for faster expiry checks
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_asset_cache_expires 
    ON asset_cache(expires_at)
  `);
  
  // Create index for cache hit tracking
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_asset_cache_hit_count 
    ON asset_cache(hit_count DESC)
  `);
};

export const down = async (pool) => {
  await pool.query('DROP INDEX IF EXISTS idx_asset_cache_hit_count');
  await pool.query('DROP INDEX IF EXISTS idx_asset_cache_expires');
  await pool.query('DROP TABLE IF EXISTS asset_cache');
};