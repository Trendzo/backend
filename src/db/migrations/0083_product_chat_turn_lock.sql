ALTER TABLE product_chat_sessions ADD COLUMN IF NOT EXISTS turn_locked_until timestamptz;
