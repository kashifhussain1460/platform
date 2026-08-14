-- WAVE 2 §2.1 — department scoping for the central authorization layer.
--
-- `scopes` lists the resource scopes a department may act on (WorkflowCategory /
-- EmployeeRole / knowledge category names). An EMPTY array means unrestricted,
-- which is the default for every existing row: department isolation ships inert
-- and a tenant enables it by writing its departments' scopes. Introducing an
-- authorization rule that immediately starts denying live users would present as
-- an outage rather than as a control.
ALTER TABLE "Department" ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
