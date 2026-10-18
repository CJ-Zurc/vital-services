# VITAL documentation

- [Architecture](architecture.md): ownership, requests, events and storage.
- [Deployment](deployment.md): default Compose and process lifecycle.
- [Configuration](configuration.md): env/secret ownership.
- [Integration](integration_guide.md): Gateway/Auth/EHR/TRACE/Audit/Notification boundaries.
- [Testing](testing.md): source suites and staging verification.
- [Security](security.md): trusted identity and transport requirements.

The root [VM runbook](../../docs/deployment/single-azure-vm.md) is authoritative
for server provisioning and manual staging deployment. Feature contract documents
describe implemented interfaces; source tests do not certify a deployed workflow.
