-- Preserve whether a restored token came from the shared service or the operator.
-- A valid manual fallback is retained until its expiry instead of being overwritten.
alter table dhan_session add column token_source text not null default '';
