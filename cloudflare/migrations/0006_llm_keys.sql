-- Bring your own LLM key: one provider key per user, sealed with AES-GCM (secret TOKEN_ENC_KEY,
-- associated data 'llm-api-key:<user id>', so a sealed key only opens for its own user).
-- The key itself is never returned to the browser; key_last4 is what the UI shows.
CREATE TABLE llm_keys (
    user_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,                    -- gemini | openai | anthropic | openrouter
    model TEXT NOT NULL,
    key_enc TEXT NOT NULL,
    key_last4 TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',         -- ok | invalid (the provider rejected it during analysis)
    error TEXT,
    checked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
