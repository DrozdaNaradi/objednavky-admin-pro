-- Spusť v Supabase: SQL Editor → New query → paste → Run
-- Sdílená cache fotek produktů — všichni uživatelé čtou ze stejného zdroje

CREATE TABLE IF NOT EXISTS product_image_cache (
    id          text PRIMARY KEY DEFAULT 'main',
    map         jsonb NOT NULL DEFAULT '{}',
    updated_at  timestamptz DEFAULT now()
);

INSERT INTO product_image_cache (id, map) VALUES ('main', '{}') ON CONFLICT DO NOTHING;

ALTER TABLE product_image_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public all image cache" ON product_image_cache FOR ALL USING (true) WITH CHECK (true);
