require('dotenv').config();
const PostGISAdapter = require('./index');

/**
 * Example usage and test of PostGIS adapter
 */
async function main() {
  console.log('PostGIS Adapter Test\n');

  // Create adapter instance with configuration
  const adapter = new PostGISAdapter({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'osm',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    schema: process.env.DB_SCHEMA || 'public',
  });

  try {
    // Connect and introspect database
    console.log('Connecting to database...');
    await adapter.connect();

    // Display discovered tables
    console.log('\n=== Tables ===');
    const tables = adapter.getTables();
    tables.forEach(table => {
      console.log(`- ${table.table_name} (${(table.size_bytes / 1024 / 1024).toFixed(2)} MB)`);
    });

    // Display discovered views
    console.log('\n=== Views ===');
    const views = adapter.getViews();
    views.forEach(view => {
      console.log(`- ${view.view_name}`);
    });

    // Find OSM-specific tables
    console.log('\n=== OSM Tables ===');
    const osmTables = adapter.findOSMTables();
    osmTables.forEach(table => {
      console.log(`- ${table.table_name}`);
      const columns = adapter.getTableColumns(table.table_name);
      console.log(`  Columns: ${columns.map(c => c.column_name).join(', ')}`);
    });

    // Get country list with areas
    console.log('\n=== Countries (with calculated areas) ===');
    try {
      const countries = await adapter.getCountries();
      console.log(`Found ${countries.length} countries:\n`);
      
      countries.slice(0, 10).forEach((country, index) => {
        console.log(`${index + 1}. ${country.name}`);
        console.log(`   Area: ${parseFloat(country.area_sq_km).toLocaleString()} sq km`);
        console.log(`   Admin Level: ${country.admin_level}`);
      });

      if (countries.length > 10) {
        console.log(`\n... and ${countries.length - 10} more countries`);
      }
    } catch (error) {
      console.error('Error getting countries:', error.message);
      console.log('This might be because:');
      console.log('1. The database does not contain OSM country boundary data');
      console.log('2. The data is in a different table structure');
      console.log('3. The admin_level or boundary columns are not present');
    }

    // Close connection
    await adapter.close();

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}

module.exports = main;
