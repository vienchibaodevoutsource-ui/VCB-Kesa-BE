CREATE TYPE "RegistrationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "Registration" (
  "id" TEXT NOT NULL,
  "status" "RegistrationStatus" NOT NULL DEFAULT 'PENDING',
  "formType" TEXT,
  "fullName" TEXT NOT NULL,
  "phone" TEXT,
  "birthYear" TEXT,
  "hometown" TEXT,
  "gender" TEXT,
  "height" TEXT,
  "weight" TEXT,
  "payloadJson" TEXT,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Registration_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Registration_status_createdAt_idx" ON "Registration"("status", "createdAt");
