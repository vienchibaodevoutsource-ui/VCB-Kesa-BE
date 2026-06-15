-- Enable trigram search for company name fields
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- B-tree index for factory picker filter
CREATE INDEX IF NOT EXISTS "Company_brokerCompanyId_type_idx" ON "Company" ("brokerCompanyId", "type");

-- GIN trigram indexes for ILIKE contains search
CREATE INDEX IF NOT EXISTS "Company_name_trgm_idx" ON "Company" USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Company_chineseName_trgm_idx" ON "Company" USING gin ("chineseName" gin_trgm_ops);
