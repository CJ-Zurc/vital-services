-- Preserve legacy feedback without manufacturing criterion answers.
ALTER TABLE feedback ALTER COLUMN "starRating" TYPE DOUBLE PRECISION;
ALTER TABLE feedback ADD COLUMN "ratingVersion" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "friendlinessAttitude" INTEGER, ADD COLUMN professionalism INTEGER,
 ADD COLUMN explanation INTEGER, ADD COLUMN "careServices" INTEGER;
ALTER TABLE feedback ADD CONSTRAINT feedback_criteria_valid CHECK (
 ("ratingVersion"=1 AND "friendlinessAttitude" IS NULL AND professionalism IS NULL AND explanation IS NULL AND "careServices" IS NULL)
 OR ("ratingVersion"=2 AND "friendlinessAttitude" IS NOT NULL AND professionalism IS NOT NULL AND explanation IS NOT NULL AND "careServices" IS NOT NULL
 AND "friendlinessAttitude" BETWEEN 1 AND 5 AND professionalism BETWEEN 1 AND 5 AND explanation BETWEEN 1 AND 5 AND "careServices" BETWEEN 1 AND 5
 AND "starRating"=("friendlinessAttitude"+professionalism+explanation+"careServices")/4.0));
CREATE INDEX feedback_v2_doctor ON feedback ("doctorId") WHERE "ratingVersion"=2;
UPDATE vital_doctors d SET "starRating"=COALESCE((SELECT AVG(f."starRating") FROM feedback f JOIN appointments a ON a.id=f."appointmentId" WHERE COALESCE(f."doctorId",a."doctorId")=d."userId" AND a.status='completed' AND f."ratingVersion"=2),0);
CREATE TABLE doctor_directory_state (id INTEGER PRIMARY KEY CHECK(id=1),generation TEXT,"requestedVersion" BIGINT NOT NULL DEFAULT 1,"publishedVersion" BIGINT NOT NULL DEFAULT 0,"calendarVersion" BIGINT NOT NULL DEFAULT 0,"refreshedAt" TIMESTAMP(3));
INSERT INTO doctor_directory_state(id) VALUES(1);
CREATE TABLE doctor_directory_entries (generation TEXT NOT NULL,"doctorId" TEXT NOT NULL REFERENCES vital_doctors("userId") ON DELETE CASCADE ON UPDATE CASCADE,"authId" TEXT NOT NULL,name TEXT NOT NULL,email TEXT,PRIMARY KEY(generation,"doctorId"));
CREATE INDEX doctor_directory_member ON doctor_directory_entries("doctorId");
CREATE FUNCTION vital_directory_dirty() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE doctor_directory_state SET "requestedVersion"="requestedVersion"+1 WHERE id=1;
 RETURN NULL;
END $$;
CREATE TRIGGER doctor_directory_dirty AFTER INSERT OR UPDATE OR DELETE ON vital_doctors FOR EACH STATEMENT EXECUTE FUNCTION vital_directory_dirty();
CREATE FUNCTION vital_directory_member_dirty() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.role='doctor' THEN UPDATE doctor_directory_state SET "requestedVersion"="requestedVersion"+1 WHERE id=1; END IF;
 ELSIF TG_OP='DELETE' THEN
  IF OLD.role='doctor' THEN UPDATE doctor_directory_state SET "requestedVersion"="requestedVersion"+1 WHERE id=1; END IF;
 ELSIF OLD.role='doctor' OR NEW.role='doctor' THEN
  UPDATE doctor_directory_state SET "requestedVersion"="requestedVersion"+1 WHERE id=1;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER doctor_directory_member_dirty AFTER INSERT OR UPDATE OR DELETE ON vital_users FOR EACH ROW EXECUTE FUNCTION vital_directory_member_dirty();

-- A constant-size discovery revision avoids hashing every doctor/profile on each page.
CREATE FUNCTION vital_discovery_dirty() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE doctor_directory_state SET "calendarVersion"="calendarVersion"+1 WHERE id=1;
 RETURN NULL;
END $$;
CREATE TRIGGER doctor_discovery_schedule_dirty AFTER INSERT OR UPDATE OR DELETE ON schedules FOR EACH STATEMENT EXECUTE FUNCTION vital_discovery_dirty();
CREATE TRIGGER doctor_discovery_appointment_dirty AFTER INSERT OR UPDATE OR DELETE ON appointments FOR EACH STATEMENT EXECUTE FUNCTION vital_discovery_dirty();
CREATE TRIGGER doctor_discovery_feedback_dirty AFTER INSERT OR UPDATE OR DELETE ON feedback FOR EACH STATEMENT EXECUTE FUNCTION vital_discovery_dirty();
CREATE TRIGGER doctor_discovery_hospital_dirty AFTER INSERT OR UPDATE OR DELETE ON hospital_affiliations FOR EACH STATEMENT EXECUTE FUNCTION vital_discovery_dirty();
