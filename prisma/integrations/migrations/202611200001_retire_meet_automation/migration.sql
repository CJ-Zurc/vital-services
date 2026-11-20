-- Run only with old API/workers stopped. Keep saved resources and historical generations.
UPDATE google_meet_connections SET "accessToken"=NULL,"refreshToken"=NULL,
  "googleSubject"=NULL,email=NULL,scopes='{}',"expiresAt"=NULL,status='retired',
  revision=revision+1,"refreshLease"=NULL,"refreshLeaseUntil"=NULL,"updatedAt"=NOW();
UPDATE google_meet_oauth_states SET secret='',"bindingHash"='',state='retired',outcome='retired';
UPDATE video_operations SET state='completed',"failureCode"='MEET_AUTOMATION_RETIRED',
  "resultMetadata"='{}'::jsonb,"leaseOwner"=NULL,"leaseUntil"=NULL,"updatedAt"=NOW()
  WHERE action IN ('oauth.start','oauth.callback','generate','disconnect') AND state IN ('prepared','executing','unknown');
UPDATE google_meet_generations SET status='failed',"failureCode"='MEET_AUTOMATION_RETIRED',
  "executionLeaseOwner"=NULL,"executionLeaseUntil"=NULL,version=version+1
  WHERE status IN ('creating','uncertain','ready') AND "claimedAppointmentId" IS NULL
    AND "reservedWorkflowId" IS NULL;
