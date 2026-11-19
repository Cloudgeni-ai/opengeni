-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS connections_nango_connection_id_idx
ON connections ((metadata ->> 'nangoConnectionId'))
WHERE metadata ->> 'integrationBackend' = 'nango';
