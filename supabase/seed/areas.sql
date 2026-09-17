-- Development-only areas and places (spec §117, DB_API §5/§10; ARCHITECTURE §15).
--
-- Extra neighborhoods for the seeded cities so the map and the Neighborhood radius have something
-- to show outside San Francisco: Oakland (Temescal, Rockridge, Lake Merritt), New York
-- (Williamsburg, East Village, Harlem) and Los Angeles (Silver Lake, Venice), plus a few public
-- places. Everything is marked `is_fixture = true`; the production-safe base rows come from
-- migration 0510_areas_base.sql. Idempotent: rows are keyed by slug / provider reference and
-- updated in place on every run (`pnpm db:reset`, `pnpm db:seed`). Never applied in production.

-- Oakland --------------------------------------------------------------------------------------------
select earth.area_upsert('usa-ca-oakland-temescal', 'neighborhood', 'Temescal', 'usa-ca-oakland', 37.8340, -122.2620,
  'POLYGON((-122.272 37.826, -122.252 37.826, -122.252 37.842, -122.272 37.842, -122.272 37.826))', true);

select earth.area_upsert('usa-ca-oakland-rockridge', 'neighborhood', 'Rockridge', 'usa-ca-oakland', 37.8470, -122.2510,
  'POLYGON((-122.262 37.842, -122.240 37.842, -122.240 37.856, -122.262 37.856, -122.262 37.842))', true);

select earth.area_upsert('usa-ca-oakland-lake-merritt', 'neighborhood', 'Lake Merritt', 'usa-ca-oakland', 37.8050, -122.2590,
  'POLYGON((-122.270 37.796, -122.248 37.796, -122.248 37.814, -122.270 37.814, -122.270 37.796))', true);

-- New York -------------------------------------------------------------------------------------------
select earth.area_upsert('usa-ny-new-york-williamsburg', 'neighborhood', 'Williamsburg', 'usa-ny-new-york', 40.7081, -73.9571,
  'POLYGON((-73.970 40.698, -73.940 40.698, -73.940 40.722, -73.970 40.722, -73.970 40.698))', true);

select earth.area_upsert('usa-ny-new-york-east-village', 'neighborhood', 'East Village', 'usa-ny-new-york', 40.7265, -73.9815,
  'POLYGON((-73.992 40.720, -73.972 40.720, -73.972 40.734, -73.992 40.734, -73.992 40.720))', true);

select earth.area_upsert('usa-ny-new-york-harlem', 'neighborhood', 'Harlem', 'usa-ny-new-york', 40.8116, -73.9465,
  'POLYGON((-73.960 40.796, -73.930 40.796, -73.930 40.830, -73.960 40.830, -73.960 40.796))', true);

-- Los Angeles ----------------------------------------------------------------------------------------
select earth.area_upsert('usa-ca-los-angeles-silver-lake', 'neighborhood', 'Silver Lake', 'usa-ca-los-angeles', 34.0869, -118.2702,
  'POLYGON((-118.285 34.075, -118.255 34.075, -118.255 34.100, -118.285 34.100, -118.285 34.075))', true);

select earth.area_upsert('usa-ca-los-angeles-venice', 'neighborhood', 'Venice', 'usa-ca-los-angeles', 33.9850, -118.4695,
  'POLYGON((-118.485 33.975, -118.455 33.975, -118.455 34.000, -118.485 34.000, -118.485 33.975))', true);

-- Places ---------------------------------------------------------------------------------------------
select earth.place_upsert('lake-merritt', 'Lake Merritt', 'usa-ca-oakland-lake-merritt', 37.8044, -122.2590, 'park', true);
select earth.place_upsert('mccarren-park', 'McCarren Park', 'usa-ny-new-york-williamsburg', 40.7213, -73.9520, 'park', true);
select earth.place_upsert('tompkins-square-park', 'Tompkins Square Park', 'usa-ny-new-york-east-village', 40.7265, -73.9817, 'park', true);
select earth.place_upsert('venice-beach', 'Venice Beach', 'usa-ca-los-angeles-venice', 33.9850, -118.4695, 'beach', true);
select earth.place_upsert('silver-lake-reservoir', 'Silver Lake Reservoir', 'usa-ca-los-angeles-silver-lake', 34.0980, -118.2620, 'park', true);
