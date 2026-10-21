-- Least-privilege PostgreSQL setup. Executed by scripts/pg-setup.ts, which
-- substitutes {{...}} placeholders with escaped literals/identifiers.
-- Section 1 runs once on the maintenance database; section 2 runs in each
-- application database (aviation, aviation_test).

-- @cluster
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aviation_migrator') THEN
    CREATE ROLE aviation_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aviation_ingest') THEN
    CREATE ROLE aviation_ingest LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aviation_app') THEN
    CREATE ROLE aviation_app LOGIN;
  END IF;
END $$;
ALTER ROLE aviation_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD {{MIGRATOR_PASSWORD}};
ALTER ROLE aviation_ingest NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD {{INGEST_PASSWORD}};
ALTER ROLE aviation_app NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD {{APP_PASSWORD}};

-- @database
-- The migrator owns the database and schema; nobody else may create objects.
ALTER DATABASE {{DB}} OWNER TO aviation_migrator;
REVOKE ALL ON DATABASE {{DB}} FROM PUBLIC;
GRANT CONNECT ON DATABASE {{DB}} TO aviation_migrator, aviation_ingest, aviation_app;
ALTER SCHEMA public OWNER TO aviation_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO aviation_ingest, aviation_app;

-- Future tables and sequences created by the migrator are readable by both
-- runtime roles. Later migrations grant DML explicitly: corpus tables to
-- aviation_ingest, product/control tables to aviation_app.
ALTER DEFAULT PRIVILEGES FOR ROLE aviation_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO aviation_ingest, aviation_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aviation_migrator IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO aviation_ingest, aviation_app;
