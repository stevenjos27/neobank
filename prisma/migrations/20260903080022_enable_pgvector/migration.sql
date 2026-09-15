-- pgvector must be enabled per database. The Docker image ships the extension;
-- this makes it available to this database. Neon supports it on the free tier.
CREATE EXTENSION IF NOT EXISTS vector;
