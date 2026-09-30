CREATE FUNCTION mailflow_mark_delivery_search_dirty() RETURNS trigger AS $$
BEGIN
  INSERT INTO search_index_outbox (id, user_id, delivery_id, state, revision, attempts, created_at, updated_at)
  VALUES (gen_random_uuid(), NEW.user_id, NEW.id, 'pending', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT (delivery_id) DO UPDATE SET
    state = 'pending',
    revision = search_index_outbox.revision + 1,
    indexed_at = NULL,
    updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER email_deliveries_search_dirty
AFTER INSERT OR UPDATE ON email_deliveries
FOR EACH ROW EXECUTE FUNCTION mailflow_mark_delivery_search_dirty();

INSERT INTO search_index_outbox (id, user_id, delivery_id, state, revision, attempts, created_at, updated_at)
SELECT gen_random_uuid(), user_id, id, 'pending', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM email_deliveries
ON CONFLICT (delivery_id) DO NOTHING;