-- Marketing workspace: the Postiz tenancy bridge.
--
-- Every Orlixa company shares ONE self-hosted Postiz instance, so a Postiz
-- `Customer` ("group") id is the only boundary between one tenant's connected
-- social accounts and another's (postiz-engine.md §20). Nullable because no
-- company has one until a platform operator assigns it; the account-import
-- path fails closed on null rather than importing untagged integrations.
ALTER TABLE "Company" ADD COLUMN "postizCustomerGroupId" TEXT;
