-- Preserve byte count independently of expiring candidate buffers. Old rows
-- whose bytes have already been erased remain NULL and fail closed in delivery.
ALTER TABLE publication_delegations ADD COLUMN request_bytes BIGINT
  CHECK(request_bytes IS NULL OR request_bytes BETWEEN 1 AND 78643200);
ALTER TABLE publication_delegations DISABLE TRIGGER publication_delegation_immutable;
UPDATE publication_delegations d SET request_bytes=t.candidate_bytes
  FROM publication_tasks t WHERE t.id=d.task_id AND t.candidate_bytes BETWEEN 1 AND 78643200
  AND t.candidate IS NOT NULL AND octet_length(t.candidate)=t.candidate_bytes;
ALTER TABLE publication_delegations ENABLE TRIGGER publication_delegation_immutable;

ALTER TABLE publication_delegation_outbox
  ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN lease_token UUID,
  ADD COLUMN lease_until TIMESTAMPTZ,
  ADD COLUMN delivered_at TIMESTAMPTZ,
  ADD COLUMN local_intent_cancelled BOOLEAN,
  ADD COLUMN last_code TEXT,
  ADD CONSTRAINT publication_receipt_delivery_state CHECK(delivery_state IN ('pending','leased','delivered','blocked','exhausted')),
  ADD CONSTRAINT publication_receipt_delivery_attempts CHECK(delivery_attempts BETWEEN 0 AND 8 AND (delivery_state<>'pending' OR delivery_attempts<8)),
  ADD CONSTRAINT publication_receipt_delivery_lease CHECK(
    (delivery_state='leased' AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND delivery_attempts>0) OR
    (delivery_state<>'leased' AND lease_token IS NULL AND lease_until IS NULL)),
  ADD CONSTRAINT publication_receipt_delivery_ack CHECK(
    (delivery_state='delivered' AND delivered_at IS NOT NULL AND local_intent_cancelled IS NOT NULL) OR
    (delivery_state<>'delivered' AND delivered_at IS NULL AND local_intent_cancelled IS NULL)),
  ADD CONSTRAINT publication_receipt_delivery_code CHECK(last_code IS NULL OR last_code IN ('unavailable','conflict','evidence_missing','exhausted'));
CREATE INDEX publication_receipt_delivery_due ON publication_delegation_outbox(delivery_state,next_attempt_at,created_at);
CREATE FUNCTION guard_publication_receipt_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Publication receipt event is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER publication_receipt_event_immutable BEFORE UPDATE ON publication_delegation_outbox
  FOR EACH ROW EXECUTE FUNCTION guard_publication_receipt_event();
