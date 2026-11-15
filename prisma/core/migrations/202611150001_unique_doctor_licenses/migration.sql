BEGIN;

-- Check normalized collisions without including credential values in migration logs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM vital_doctors WHERE prc_license IS NOT NULL
    GROUP BY upper(regexp_replace(btrim(prc_license), '[[:space:]-]', '', 'g'))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate normalized PRC licenses. Resolve the assignments with an administrator before migration.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM vital_doctors WHERE "s2License" IS NOT NULL
    GROUP BY upper(regexp_replace(btrim("s2License"), '[[:space:]-]', '', 'g'))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate normalized PDEA S-2 licenses. Resolve the assignments with an administrator before migration.';
  END IF;
END $$;

CREATE UNIQUE INDEX vital_doctors_prc_normalized_uidx
ON vital_doctors (upper(regexp_replace(btrim(prc_license), '[[:space:]-]', '', 'g')))
WHERE prc_license IS NOT NULL;

CREATE UNIQUE INDEX vital_doctors_s2_normalized_uidx
ON vital_doctors (upper(regexp_replace(btrim("s2License"), '[[:space:]-]', '', 'g')))
WHERE "s2License" IS NOT NULL;

COMMIT;
