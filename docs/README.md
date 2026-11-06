# VITAL Services documentation

## Architecture

- [Service architecture](architecture/architecture.md)
- [Request and event flows](architecture/flows.md)
- [Security and trusted transport](architecture/security.md)

## Operations

- [Deployment and process lifecycle](operations/deployment.md)
- [Configuration and secret ownership](operations/configuration.md)
- [Production configuration reference](operations/configuration-reference.md)
- [Testing and staging verification](operations/testing.md)

Feature contracts describe implemented interfaces. Source tests establish source behavior, while deployed workflows require runtime verification.

## Integrations

- [Gateway, Auth, EHR, TRACE, Audit, and Notification contracts](integrations/integration_guide.md)
- [API reference](integrations/api_reference.md)
- [Audit integration](integrations/audit-integration.md) and [verification](integrations/audit-verification.md)
- [Department and specialty catalog](integrations/department_catalog.md)
- [VITAL feedback on the TRACE patient-feedback plan](integrations/trace/patient-feedback/VITAL_Feedback_on_TRACE_Integration_Plan.md)

## Clinical workflows

- [Signing, controlled medicines, and acknowledgments](clinical-workflows/capstone-documents.md)
- [Temporary capstone file validation](clinical-workflows/capstone-file-validation.md)
- [Portal consistency and clinical review](clinical-workflows/portal-consistency.md) and [follow-up revisions](clinical-workflows/portal-consistency-v2.md)

## Event-driven architecture

- [EDA documents and baselines](eda/)
- [Runtime contracts](eda/contracts.md)
- [Infrastructure](eda/eda-infrastructure.md) and [profiles](eda/eda-profile.md)
- [Messaging](eda/messaging-ownership.md), [payments](eda/payment-ownership.md), [records](eda/records-ownership.md), and [video](eda/video-ownership.md)
- [Appointment lifecycle](eda/appointment-lifecycle.md) and [Sprint 6 appointment revisions](eda/sprint6-appointment-revisions.md)

## Intelligence

- [Intelligent intake and symptom analytics](intelligence/intelligence.md)
- [Implementation brief](intelligence/vital-ai-implementation.md), [verification](intelligence/intelligence-verification.md), and [status report](intelligence/vital-ai-status-and-completion-report.md)
- [TRACE specialty mapping](intelligence/department-mapping.md)
