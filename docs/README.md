# VITAL documentation

- [Architecture](architecture.md): ownership, requests, events and storage.
- [Deployment](deployment.md): default Compose and process lifecycle.
- [Configuration](configuration.md): env/secret ownership.
- [Integration](integration_guide.md): Gateway/Auth/EHR/TRACE/Audit/Notification boundaries.
- [Testing](testing.md): source suites and staging verification.
- [Security](security.md): trusted identity and transport requirements.
- [Capstone documents](capstone-documents.md): S6 signing, controlled medicines,
  acknowledgments, migrations and verification limits.
- [Temporary capstone file validation](capstone-file-validation.md): source-owned
  demo policy, truthful inspection evidence and restoration of antivirus.

The root [VM runbook](../../docs/deployment/single-azure-vm.md) is authoritative
for server provisioning and manual staging deployment. Feature contract documents
describe implemented interfaces; source tests do not certify a deployed workflow.


- [S6 appointment revisions](eda/sprint6-appointment-revisions.md): ratings, complaint history, calendar review, quotas and VITAL inbox contracts.
See [department and specialty contracts](department_catalog.md).
