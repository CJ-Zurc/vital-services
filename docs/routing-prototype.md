> **Retired scope:** Specialty recommendations are unavailable. This document is historical reference; no routing rules are loaded by the current booking/summary workflow. See [the current implementation](vital-ai-implementation.md).

# Draft routing criteria for clinical review

**Unreviewed prototype material. These are candidate categories to investigate, not patient instructions or approved clinical rules.**

| Reported concern | Candidate services to review locally | Information and exclusions to define with clinicians |
|---|---|---|
| Skin itching or rash | Dermatology; general outpatient service | Age, distribution, onset, associated symptoms, urgent-presentation exclusions |
| Joint or movement-related discomfort | Orthopedics; general outpatient service | Injury, anatomical location, function, onset, progression, exclusions |
| Ear/nose/throat symptoms | ENT; general outpatient service | Age, duration, associated symptoms, examination requirements, exclusions |
| Recurrent head discomfort | General outpatient service; neurology if local referral criteria support it | Onset, neurological symptoms, prior assessment, urgency exclusions |
| Digestive complaints | General outpatient service; gastroenterology when criteria support it | Location, duration, associated symptoms, age and referral criteria |
| Urinary complaints | General outpatient service; urology when criteria support it | Age, relevant patient context, associated symptoms, testing and urgency criteria |
| Eye complaints | Ophthalmology when offered; general outpatient service | Visual symptoms, onset, injury, examination and escalation criteria |
| Pediatric complaints | Pediatrics or age-eligible general outpatient service | Clinician-defined age bands, complaint-specific escalation and eligibility |

Do not automatically turn these categories into symptom-to-specialty rules. Consult the hospital's actual service definitions and referral requirements. BODHI candidate specialties are associations, not evidence that any listed service is the correct first contact.

## Rule authoring

Each rule carries an ID, required canonical positive symptom IDs, hospital department UUID, BODHI-normalized discipline, minimum/maximum age, explanation, evidence URLs, and an outcome: `suggestions_available`, `clarification_required`, or `escalation`. Optional structured criteria include severity bounds, onset categories, progression categories, radiation, and required supplied fields. Missing criteria must never be invented.

Escalation/clarification rules take precedence over routine suggestions. Normalized concepts with unresolved contradictions must not silently qualify. Availability is evaluated only after suitability.

Reviewer workflow:

1. Obtain the active TRACE department lookup; replace no IDs with placeholder specialty slugs.
2. Define complaint-specific criteria with clinicians, including urgent and insufficient-evidence cases.
3. Add independent synthetic cases for adults and children, each with expected accepted departments or abstention/escalation.
4. Exercise the staff sandbox, original answers, corrected symptoms, candidate generation, and no-slot behavior.
5. Record reviewer identity, evidence and approval timestamp in a versioned artifact only after review. Production requires `status: approved`, reviewer and timestamp; the shipped artifact stays unreviewed.

Reference material for reviewers: [BODHI source](https://github.com/eka-care/BODHI), [NHS remote consultation guidance](https://www.england.nhs.uk/long-read/remote-consulting/), and [NICE chest-pain assessment/referral guidance](https://www.nice.org.uk/guidance/CG95/chapter/recommendations). These references are not substitutes for locally approved criteria.
