# postgis-connect

Node.js adapter to connect to a PostGIS OSM database, providing a unified access pattern to various database setups.

## Features

- **Database Introspection**: Automatically discovers tables, views, and columns in the database
- **OSM-Aware**: Recognizes common osm2pgsql table patterns and structures
- **Country Data**: Retrieve country boundaries with PostGIS-calculated areas
- **Flexible**: Adapts to different osm2pgsql configurations and table naming conventions
- **Metadata Caching**: Introspects database once and caches metadata for efficient access

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Edit `.env` with your database credentials:

```
DB_HOST=localhost
DB_PORT=5432
DB_NAME=osm
DB_USER=postgres
DB_PASSWORD=your_password
DB_SCHEMA=public
```

## Usage

### Basic Usage

```javascript
const PostGISAdapter = require('postgis-connect');

const adapter = new PostGISAdapter({
  host: 'localhost',
  port: 5432,
  database: 'osm',
  user: 'postgres',
  password: 'password',
  schema: 'public'
});

// Connect and introspect database
await adapter.connect();

// Get all tables
const tables = adapter.getTables();

// Get OSM-specific tables
const osmTables = adapter.findOSMTables();

// Get countries with calculated areas
const countries = await adapter.getCountries();

// Close connection
await adapter.close();
```

### Database Introspection

The adapter automatically introspects the database to discover:

1. **Tables**: All tables in the schema with size information
2. **Views**: All views in the schema with their definitions
3. **Columns**: All columns in tables and views with data types

```javascript
// Get all discovered tables
const tables = adapter.getTables();

// Get all discovered views
const views = adapter.getViews();

// Get columns for a specific table
const columns = adapter.getTableColumns('planet_osm_polygon');

// Get full metadata for a table
const metadata = adapter.getTableMetadata('planet_osm_polygon');
```

### Working with OSM Data

The adapter recognizes common osm2pgsql patterns:

```javascript
// Find all OSM-related tables
const osmTables = adapter.findOSMTables();
// Returns tables matching patterns like:
// - planet_osm_point
// - planet_osm_line
// - planet_osm_polygon
// - planet_osm_roads
```

### Getting Country Data

Retrieve country boundaries with PostGIS-calculated areas:

```javascript
const countries = await adapter.getCountries();
// Returns array of countries with:
// - name: Country name
// - admin_level: OSM admin level (2 for countries)
// - boundary: Boundary type
// - area_sq_km: Area in square kilometers
// - area_sq_meters: Area in square meters
```

### Raw Queries

Execute custom SQL queries:

```javascript
const result = await adapter.query(
  'SELECT name, ST_Area(way::geography) as area FROM planet_osm_polygon WHERE admin_level = $1',
  ['2']
);
```

## Testing

Run the test/example script:

```bash
npm test
```

This will:
1. Connect to the database
2. Display discovered tables and views
3. Show OSM-specific tables and their columns
4. List countries with calculated areas

## How it Works

### Database Introspection

On connection, the adapter runs several queries to understand the database structure:

1. Queries `information_schema.tables` to find all tables and their sizes
2. Queries `information_schema.views` to discover views
3. Queries `information_schema.columns` to get column information

This metadata is cached and used to:
- Adapt to different osm2pgsql configurations
- Find the correct geometry column names (way, geom, etc.)
- Identify OSM-specific tables
- Ensure correct table and column access

### Country Detection

The `getCountries()` method:

1. Identifies potential tables containing country boundaries (polygon tables)
2. Checks for necessary columns (name, admin_level, boundary, geometry)
3. Queries for features with `admin_level = '2'` and `boundary = 'administrative'`
4. Calculates areas using PostGIS `ST_Area()` function
5. Returns results sorted by area (largest first)

### OSM2PGSQL Compatibility

The adapter works with various osm2pgsql configurations by:

- Detecting table naming patterns (planet_osm_*, osm_*, etc.)
- Identifying geometry column names dynamically (way, geom, etc.)
- Supporting different data types (geometry, geography)
- Adapting queries based on discovered schema

## License

MIT
