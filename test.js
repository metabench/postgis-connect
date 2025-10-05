const PostGISAdapter = require('./index');

/**
 * Example usage and test of PostGIS adapter
 */
async function main() {
  console.log('PostGIS Adapter Test\n');

  // Create adapter instance - it will automatically load from config/config.json
  let adapter;
  try {
    adapter = new PostGISAdapter();
    console.log('✓ Loaded configuration from config/config.json');
  } catch (error) {
    console.log('Config file not found, using manual configuration');
    // Fallback to environment variables or defaults
    require('dotenv').config();
    adapter = new PostGISAdapter({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'osm',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      schema: process.env.DB_SCHEMA || 'public',
    });
  }

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

      // Test hierarchical admin area features
      console.log('\n=== Hierarchical Admin Areas (Facade Pattern) ===');
      
      // Test getting admin areas by level
      console.log('\n--- Admin Level 4 Areas (States/Provinces) ---');
      try {
        const level4Areas = await adapter.getAdminAreasByLevel('4');
        console.log(`Found ${level4Areas.length} admin level 4 areas`);
        if (level4Areas.length > 0) {
          console.log('Sample areas:');
          level4Areas.slice(0, 5).forEach((area, index) => {
            console.log(`  ${index + 1}. ${area.name} (${parseFloat(area.area_sq_km).toLocaleString()} sq km)`);
          });
        }
      } catch (error) {
        console.log(`Could not retrieve level 4 areas: ${error.message}`);
      }

      // Test getting admin areas within a country
      if (countries.length > 0) {
        const testCountry = countries[0].name;
        console.log(`\n--- Admin Areas within ${testCountry} ---`);
        try {
          const nextLevel = await adapter.getNextAdminLevelInCountry(testCountry);
          if (nextLevel.areas.length > 0) {
            console.log(`Found ${nextLevel.areas.length} areas at admin level ${nextLevel.adminLevel}:`);
            nextLevel.areas.slice(0, 5).forEach((area, index) => {
              console.log(`  ${index + 1}. ${area.name} (${parseFloat(area.area_sq_km).toLocaleString()} sq km)`);
            });
          } else {
            console.log(`No sub-admin areas found for ${testCountry}`);
          }
        } catch (error) {
          console.log(`Could not retrieve sub-areas: ${error.message}`);
        }
      }

      // Test hierarchical structure
      console.log('\n--- Hierarchical Structure (Countries with Sub-areas) ---');
      try {
        console.log('Building hierarchical structure for top 3 countries...');
        const topCountries = countries.slice(0, 3);
        const hierarchical = [];
        
        for (const country of topCountries) {
          const nextLevel = await adapter.getNextAdminLevelInCountry(country.name);
          hierarchical.push({
            country: country.name,
            area_sq_km: country.area_sq_km,
            subAdminLevel: nextLevel.adminLevel,
            subAreaCount: nextLevel.areas.length,
            topSubAreas: nextLevel.areas.slice(0, 3).map(a => a.name),
          });
        }

        hierarchical.forEach((item, index) => {
          console.log(`\n${index + 1}. ${item.country}`);
          console.log(`   Area: ${parseFloat(item.area_sq_km).toLocaleString()} sq km`);
          console.log(`   Sub-areas (level ${item.subAdminLevel}): ${item.subAreaCount}`);
          if (item.topSubAreas.length > 0) {
            console.log(`   Top sub-areas: ${item.topSubAreas.join(', ')}`);
          }
        });
      } catch (error) {
        console.log(`Could not build hierarchical structure: ${error.message}`);
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
