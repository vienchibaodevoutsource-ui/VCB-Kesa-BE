ALTER TABLE "PartnerSync" ADD COLUMN "answers" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "questionSnapshot" JSONB;
