import { z } from "zod";
import { dateOnly } from "./appointment-contracts.js";

// Versioned labels from the existing Web react-body-map-sdk English catalogue.
const regions = ["Right pectoral","Right rib","Right shoulder (ant.)","Right elbow (ant.)","Right obliques","Right forearm (ant.) (flexors)","Right wrist (ant.)","Right knee (ant.)","Right shin","Right abdominals","Neck (R)","Right quadriceps","Right trapezius","Right ankle (ant.)","Right foot","Right adductor","Right hip","Right biceps","Right hand (ant.) (palmar surface)","Head (ant.)","Left pectoral","Left rib","Left shoulder (ant.)","Left elbow (ant.)","Left obliques","Left forearm (ant.) (flexors)","Left wrist (ant.)","Left knee (ant.)","Left shin","Left abdominals","Neck (L)","Left quadriceps","Left trapezius","Left ankle (ant.)","Left foot","Left adductor","Left hip","Left biceps","Left hand (ant.) (palmar surface)","Spinal column","Head (post.)","Back (Left side)","Left shoulder (post.)","Left elbow (post.)","Left forearm (post.) (extensors)","Left wrist (post.)","Left hamstring","Left calf","Left trapezius","Left ankle (post.)","Left hand (post.) (dorsale surface)","Left triceps","Left buttock","Left scapula surface","Left foot (post.)","Left lumbar","Left knee (post.)","Back (Right side)","Right shoulder (post.)","Right elbow (post.)","Right forearm (post.) (extensors)","Right wrist (post.)","Right hamstring","Right calf","Right trapezius","Right ankle (post.)","Right hand (post.) (dorsale surface)","Right triceps","Right buttock","Right scapula surface","Right foot (post.)","Right lumbar","Right knee (post.)"];
const location = z.object({ kind: z.enum(["BODY_MAP", "GENERALIZED", "OTHER"]), partId: z.number().int().nonnegative().nullable(), label: z.string().trim().min(1).max(200) }).strict().refine(x =>
  x.kind === "BODY_MAP" ? x.partId !== null && regions[x.partId] === x.label : x.partId === null);
const text = z.string().max(2000);
export const intakeSchema = z.object({
  version: z.literal(1), symptomStartedAt: dateOnly.nullable(), symptomStartedApprox: z.string().max(200).nullable(),
  onsetType: z.enum(["SUDDEN", "GRADUAL", "UNKNOWN"]), aggravatingFactors: text, relievingFactors: text,
  symptomQuality: z.array(z.enum(["Aching", "Burning", "Cramping", "Dull", "Heavy", "Numb", "Pressure", "Sharp", "Stabbing", "Throbbing", "Tingling", "Tight", "Other"])).min(1).max(13),
  symptomQualityOther: z.string().max(200).nullable(), symptomLocation: location, specificBodyPart: z.string().trim().max(200).optional(),
  radiates: z.enum(["YES", "NO", "UNKNOWN"]), radiationLocation: location.nullable(), severity: z.number().int().min(0).max(10),
  timingPattern: z.enum(["CONSTANT", "INTERMITTENT", "EPISODIC", "UNKNOWN"]), episodeDurationValue: z.number().positive().max(100000).nullable(),
  episodeDurationUnit: z.enum(["MINUTES", "HOURS", "DAYS"]).nullable(), progression: z.enum(["IMPROVING", "UNCHANGED", "WORSENING", "VARIABLE", "UNKNOWN"]),
  associatedSymptoms: text, additionalNotes: text,
}).strict().superRefine((x, ctx) => {
  const invalid = (key: string) => ctx.addIssue({ code: "custom", path: [key], message: "Invalid symptom assessment." });
  if (!x.symptomStartedAt && !x.symptomStartedApprox?.trim()) invalid("symptomStartedApprox");
  if (x.symptomStartedAt && x.symptomStartedAt > new Date(Date.now() + 8 * 3600000).toISOString().slice(0,10)) invalid("symptomStartedAt");
  if (x.symptomQuality.includes("Other") && !x.symptomQualityOther?.trim()) invalid("symptomQualityOther");
  if (x.radiates === "YES" && !x.radiationLocation) invalid("radiationLocation");
  if (["INTERMITTENT","EPISODIC"].includes(x.timingPattern) && (!x.episodeDurationValue || !x.episodeDurationUnit)) invalid("episodeDurationValue");
}).transform(x => ({ ...x, symptomQualityOther: x.symptomQuality.includes("Other") ? x.symptomQualityOther : null,
  radiationLocation: x.radiates === "YES" ? x.radiationLocation : null,
  episodeDurationValue: ["INTERMITTENT","EPISODIC"].includes(x.timingPattern) ? x.episodeDurationValue : null,
  episodeDurationUnit: ["INTERMITTENT","EPISODIC"].includes(x.timingPattern) ? x.episodeDurationUnit : null }));
export const emergencyContactSchema = z.object({ fullName: z.string().trim().min(1).max(160), relationship: z.string().trim().min(1).max(80),
  phoneNumber: z.string().transform(x => x.trim().replace(/[\s()-]/g, "")).transform(x => /^09\d{9}$/.test(x) ? "+63" + x.slice(1) : x)
    .pipe(z.string().regex(/^\+639\d{9}$/)) }).strict();
export const complaintSchema = z.string().trim().max(2000).nullable().optional().transform(value => value || null);
export function customBookingEnd(startTime: string) {
  const [hour, minute] = startTime.split(':').map(Number);
  const total = (hour! * 60 + minute! + 30) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
