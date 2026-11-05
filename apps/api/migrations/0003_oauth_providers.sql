-- OAuth providers other than Google (src/integrations/OAuth.ts) share `oauth_states`: their rows name the
-- provider, and carry the PKCE verifier between StartOAuthAccess and the callback. Google's rows leave both NULL.
ALTER TABLE oauth_states ADD COLUMN provider TEXT;
ALTER TABLE oauth_states ADD COLUMN code_verifier TEXT;
