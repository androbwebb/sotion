export const up = async (pool) => {
  // Add path column to url_mappings table
  await pool.query(`
    ALTER TABLE url_mappings 
    ADD COLUMN IF NOT EXISTS path VARCHAR(255),
    ADD COLUMN IF NOT EXISTS is_root BOOLEAN DEFAULT FALSE
  `);
  
  // Create unique index on path (excluding NULL values)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_url_mappings_path 
    ON url_mappings(path) 
    WHERE path IS NOT NULL
  `);
  
  // Create index for root page lookup
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_url_mappings_root 
    ON url_mappings(is_root) 
    WHERE is_root = TRUE
  `);
  
  // Update existing root page if configured
  await pool.query(`
    UPDATE url_mappings 
    SET is_root = TRUE, path = '/'
    WHERE notion_url = $1
    AND NOT EXISTS (SELECT 1 FROM url_mappings WHERE is_root = TRUE)
  `, [process.env.ROOT_NOTION_PAGE || '']);
};

export const down = async (pool) => {
  await pool.query('DROP INDEX IF EXISTS idx_url_mappings_root');
  await pool.query('DROP INDEX IF EXISTS idx_url_mappings_path');
  await pool.query('ALTER TABLE url_mappings DROP COLUMN IF EXISTS is_root');
  await pool.query('ALTER TABLE url_mappings DROP COLUMN IF EXISTS path');
};