-- D4 data migration, split into its OWN migration on purpose: Postgres will not
-- let a transaction USE an enum value that was added in the same transaction, so
-- the backfill cannot live alongside the ALTER TYPE above.
UPDATE "Subscription" SET "status" = 'CANCELLED' WHERE "status" = 'CANCELED';
