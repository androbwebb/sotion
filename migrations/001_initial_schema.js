export const up = async (pool) => {
  // Create url_mappings table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS url_mappings (
      id VARCHAR(10) PRIMARY KEY,
      notion_url TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      access_count INTEGER DEFAULT 0,
      last_accessed TIMESTAMP
    )
  `);
  
  // Create head_configs table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS head_configs (
      id SERIAL PRIMARY KEY,
      config_type VARCHAR(20) NOT NULL,
      page_id VARCHAR(10),
      snippet TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
};

export const down = async (pool) => {
  await pool.query('DROP TABLE IF EXISTS head_configs');
  await pool.query('DROP TABLE IF EXISTS url_mappings');
};