CREATE TABLE "appointment_command_preparations" (
  id UUID PRIMARY KEY,
  "actorAuthId" TEXT NOT NULL,
  "actorRole" TEXT NOT NULL CHECK ("actorRole" IN ('doctor','patient')),
  "commandId" UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approve','follow-up','reject','reschedule','decline-reschedule','accept-reschedule','cancel','complete','schedule.write','blocks.write')),
  resource TEXT NOT NULL,
  "browserHash" TEXT NOT NULL CHECK ("browserHash" ~ '^[a-f0-9]{64}$'),
  "bindingHash" TEXT NOT NULL CHECK ("bindingHash" ~ '^[a-f0-9]{64}$'),
  "expectedVersion" INTEGER NOT NULL CHECK ("expectedVersion" >= 0),
  "expectedSourceVersion" INTEGER CHECK ("expectedSourceVersion" >= 0),
  "sourceAppointmentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("actorAuthId","commandId"),
  CHECK (("sourceAppointmentId" IS NULL) = ("expectedSourceVersion" IS NULL))
);
