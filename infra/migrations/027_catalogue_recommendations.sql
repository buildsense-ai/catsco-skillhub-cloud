CREATE TABLE catalogue_recommendations (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  revision integer NOT NULL DEFAULT 0,
  skill_ids text[] NOT NULL DEFAULT '{}'
);

INSERT INTO catalogue_recommendations (id) VALUES (true);
