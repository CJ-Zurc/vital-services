import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const web = resolve(dirname(fileURLToPath(import.meta.url)), '../../../vital-web');
const uuid = '12345678-1234-4123-8123-123456789abc';
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
// Git checkout line endings must not change the reviewed source identity.
const hash = text => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
// A review snapshot, not a parity certificate. Changes require a fresh source review.
const reviewedHashes = Object.freeze({
  'proxy.ts': 'ff7433c4f8ed9cc2f6ad874dc1085c754d79a991a6b337c76ff1cc33b7928199',
  'tests/eda-ingress-policy.test.ts': '76e048956f619a7903ef986cf8773efac21e5219b8709d076235c0f4af88b691',
  'app/api/admin/analytics/batches/current/route.ts': '077c1025999f1a3d3efb345c05b749bb8a1ed7a4ea82377c7de8a21e020eb1b8',
  'app/api/admin/analytics/batches/refresh/route.ts': 'fe0221155a744d22e7002663f6e2f1816008ff6d308deff79071a8abc078a355',
  'app/api/admin/analytics/dashboard/route.ts': 'f2dc663ffcec273c82a82cd538a2c500d291943dc46f03eb178ba740598c660a',
  'app/api/admin/concerns/[concernId]/route.ts': '30f6eb108281385a98649215f9406b81bacc99cce85c112ac8582d5de2e44a23',
  'app/api/admin/concerns/route.ts': '668f696b3acc07f886fb4a529d1320f126cfaec07bc68b9a8feb1ab29bd8f2b8',
  'app/api/admin/consent/route.ts': '2b794449aecdd21865684e890b9add1e5b196c46a31f81b5ac842aabb2fb33e2',
  'app/api/admin/dashboard/route.ts': '2b794449aecdd21865684e890b9add1e5b196c46a31f81b5ac842aabb2fb33e2',
  'app/api/admin/doctors/[authId]/credentials/route.ts': '4becacb28cfa7adf23d3f94c5cfa73f52cb121446964a8b978743a6c32561306',
  'app/api/admin/doctors/route.ts': '9fe8a7a75e4f428b5583e86374853da8289d59e402d95c2e4d07b116cbf23671',
  'app/api/admin/membership/route.ts': 'fd135765f187852cfb04b81661e69b6b49fd14b433a9d7209779593d5fd63a1b',
  'app/api/admin/messaging/conversations/[conversationId]/hold/route.ts': 'd7733f9989bff43c1188db02c8c83592be328520a051378c2dc8798c0b40a976',
  'app/api/admin/messaging/conversations/route.ts': '5596709f083a60e1279856ba2d9695775e5fd31ab3cf63736b5862b306dcdb66',
  'app/api/admin/route.ts': '03e4da65a26bf172ca2578d291100e9b0efdc63090d8aadf349310c0053f91c0',
  'app/api/admin/users/route.ts': 'dfc26bc546684683db82b8ef6c07933ff83e3ac805904ffeceb4908a1079b4d2',
  'app/api/appointments/[appointmentId]/complete/route.ts': '77e224e1b5f3493115b46d76b98bef327b42ca92e60fd8af73d07cbd6c76ea09',
  'app/api/appointments/[appointmentId]/concerns/route.ts': 'c9a3f2e09aed9310dabc01f3edc94b97be29e10c054c2f0a9e8140608301e19d',
  'app/api/appointments/[appointmentId]/feedback/route.ts': '8ec60f817fd7b204124ce1a7d6f2e989fe914f84a29a5c1e0603a768e2b6368a',
  'app/api/appointments/[appointmentId]/messages/read/route.ts': '050e1a07fbb2ff49b5deafedcafcb582e85e72ecbcf60e664afa535624435d53',
  'app/api/appointments/[appointmentId]/messages/route.ts': '8d2ccc0566a3517726c8081da359b65434ce946d260b49092b2bcc2d949751b7',
  'app/api/appointments/[appointmentId]/messages/stream/route.ts': 'daa2995b586a69b734f9acc0c48feb43aa1fc892a1c0becfee9a00399339846a',
  'app/api/auth/consent/route.ts': '17fed91b72ec50594b3e3541f86db58266d0e2d43dc7302f16e800dd595b9de6',
  'app/api/auth/google/url/route.ts': 'f9a861cb289d78583b9fa667a87a635a478bb040ea7e9cb70917be0117b67169',
  'app/api/auth/login/resend/route.ts': 'c09dea52c6b7d0682cfc859525ea6dbd0fc1f2d132d98ff277f29ceffe01c55e',
  'app/api/auth/login/route.ts': '6bf9edad13263512aebc6bf83a9fa30646e81ab9827a920202369c4905a1444f',
  'app/api/auth/logout/route.ts': '216837e425b512815376dcb19feba0a89d2c0c90443e0d4fcdd7ad27b534591d',
  'app/api/auth/me/password/route.ts': 'd9bfb29058a7dfd07debafd737cafe042340477fc2e51c1868fdfc6617e80c82',
  'app/api/auth/me/profile-picture/route.ts': '374e70b49062389f137ad219320300cb656ac918a41844907ec78a7ea6e2d6cf',
  'app/api/auth/me/route.ts': 'b1e1b38e4b84acf923a149472a20ce438ca79346254faf7f182aa5aee742a5ed',
  'app/api/auth/password/change/route.ts': '1e6cc6ae8fda65b57d3c402586d5882226d21a17410aa24b0413010a6e22fcdd',
  'app/api/auth/password/forgot/route.ts': '3015ce85ac6f3e606399ebb7079e65f83bd8859ada30411552c1e74b52d0c1b4',
  'app/api/auth/password/reset/route.ts': 'e8318058cc1be547cdfab70a39138761c2327a17e712435a8770179787b691bc',
  'app/api/auth/refresh/route.ts': 'f0fc1c99d7fb10b182858a27042c69580c9a42f3483a53b6ab59ee03033ad96e',
  'app/api/auth/register/route.ts': '9b0a3f27fb3291b6e70cb831073931131face4043fd7712f810abaa4b6432d9c',
  'app/api/auth/session/route.ts': '1f067926260b660c60a4fd25098b109800b1916b8be3fef820c1bff7f493bd0c',
  'app/api/auth/sso/callback/route.ts': '49a9807dac3b9269dca4f914b8cf6455a3756b5ec0ce9a09d48e8ecfc510ea8a',
  'app/api/auth/verify-2fa/route.ts': 'c0413deda1f0823eeaca7aefc1b924cb76e7f6f59ee72ffcb5e8f1fae245325c',
  'app/api/auth/verify/resend/route.ts': '5f65120adec569917cd988ce538b68b8a634457ca3e2b3dcb8d9f7ab94715ddf',
  'app/api/auth/verify/route.ts': 'bb2005daec82dd652a27a336d1556e7266f3cf1b755785453c7245f3a0f66e1a',
  'app/api/doctor/appointment-requests/[appointmentId]/approve/route.ts': '77e224e1b5f3493115b46d76b98bef327b42ca92e60fd8af73d07cbd6c76ea09',
  'app/api/doctor/appointment-requests/[appointmentId]/reject/route.ts': '77e224e1b5f3493115b46d76b98bef327b42ca92e60fd8af73d07cbd6c76ea09',
  'app/api/doctor/appointment-requests/route.ts': '62310fa9c2d8e19957698f861d7e2902c2edfaed3bf527d1b4f88f5ca08b25c1',
  'app/api/doctor/appointment-requests/stream/route.ts': '68a983a10b980e1b01be89350e5c1556d904a5675c1d60e8864686f9e09f3eb2',
  'app/api/doctor/appointments/[appointmentId]/cancel/route.ts': '77e224e1b5f3493115b46d76b98bef327b42ca92e60fd8af73d07cbd6c76ea09',
  'app/api/doctor/appointments/[appointmentId]/follow-up/route.ts': 'b504da935eb6c7ff53a9575733edb1c1adfc7564ed8bc260a53eeb6d51d7392a',
  'app/api/doctor/appointments/[appointmentId]/medical-certificates/route.ts': '0d3a71e60337f6607b678adba8bd3b858c814d006729a71cd25f8b2108f456d3',
  'app/api/doctor/appointments/[appointmentId]/prescriptions/route.ts': '0d3a71e60337f6607b678adba8bd3b858c814d006729a71cd25f8b2108f456d3',
  'app/api/doctor/appointments/[appointmentId]/reschedule/route.ts': '77e224e1b5f3493115b46d76b98bef327b42ca92e60fd8af73d07cbd6c76ea09',
  'app/api/doctor/appointments/[appointmentId]/vitals/route.ts': '3d9898fcc4e4dc0a7ed682b79af838e483febdf25902e36c4223c91ebc921507',
  'app/api/doctor/appointments/route.ts': '62310fa9c2d8e19957698f861d7e2902c2edfaed3bf527d1b4f88f5ca08b25c1',
  'app/api/doctor/dashboard/route.ts': '1acc7d6b518b3e2801755e6d7eae68b700d2bba38f9835bc600525d8a65c5a28',
  'app/api/doctor/date-blocks/[blockId]/route.ts': '999fa468815b3281ac8a5e9ac27bfd41c611100d8334039620091288cc0aa627',
  'app/api/doctor/date-blocks/route.ts': '9c1a688d9237d21063a3998fac4c82a8b2c8be7ba2bbedc453662c3e25a68ef1',
  'app/api/doctor/google-meet/callback/route.ts': '00dfa8d36909657567bd39aecf1b78f0deb1585593a195c148a8e0f8b4210ad5',
  'app/api/doctor/google-meet/generate/route.ts': 'bc60e4f2fa36f174f496e3b5ba22a8749e437cec96b94c6b9fcbb04c50122ffa',
  'app/api/doctor/google-meet/route.ts': '6c4148e64a906b5b4f6863219e5140ba1c4039d230e437887eda20781d3abe9d',
  'app/api/doctor/google-meet/start/route.ts': 'bc60e4f2fa36f174f496e3b5ba22a8749e437cec96b94c6b9fcbb04c50122ffa',
  'app/api/doctor/onboarding/route.ts': '799fe6976842b5312b18910872070a7cdedb3c79d5872519bd7ad6bf62c487aa',
  'app/api/doctor/patients/[patientId]/opqrst/route.ts': 'a6c3e7e7a6c759e0a4aa4af80cc9f0a0c83307875807800568036c9488f7e30f',
  'app/api/doctor/patients/[patientId]/record/route.ts': 'd900897a1c4e6b5fbb4acd0894a20d74c75f692bb632e02a1e07df7a999b503f',
  'app/api/doctor/patients/[patientId]/snapshot/route.ts': 'd1b48a6cd90873d4b0f80937b53c574d353e07838aa74411377973f6e57f1463',
  'app/api/doctor/patients/route.ts': '70b63e78117acacfb4accb12c8c1db5e40793309887f06a8eac04d38947972d4',
  'app/api/doctor/payment-qr/[qrId]/file/route.ts': '1651f810e1d06e79178f87d2a3b26e9f1177708c050a32b1761ba72d5a58f49f',
  'app/api/doctor/payment-qr/[qrId]/route.ts': '6dd2b5f8d9b292c1bd9f0a2de8fa37898143e28f3747ae09d94d5b5ffcb1418c',
  'app/api/doctor/payment-qr/operations/[operationId]/route.ts': '1651f810e1d06e79178f87d2a3b26e9f1177708c050a32b1761ba72d5a58f49f',
  'app/api/doctor/payment-qr/route.ts': '3a2b96df5aedaefa86a316211de40cdd15d41a314b0ce462380cca9f93c512cb',
  'app/api/doctor/profile/onboarding/route.ts': '399bb97ec3b2d15c11d9d1b42ef4e927668ec457070814d121f9e91ee92a800f',
  'app/api/doctor/profile/picture/route.ts': '5650658e49f123ebff6c1f43823cbdff89595372387495f1266ded151247c66d',
  'app/api/doctor/profile/route.ts': '03504f2dd154af86e9da015618a1e6ad091ad7b32043282af92896bdd9d065a7',
  'app/api/doctor/records/files/[assetId]/file/route.ts': '85de8ad4464a7776ff319f71eaa3a8540c4c471a1c0c61076263674ed3dd633c',
  'app/api/doctor/records/operations/[operationId]/route.ts': 'c8b8003bde8ed6c87373b7ffabab89db6fbe4673d79118d1b01fe25c607a4fd7',
  'app/api/doctor/route.ts': '9b50ed48998d81384edec1a06e4fcf74d68d2458ed6f672f4536bff5e197350d',
  'app/api/doctor/schedule/[slotId]/route.ts': 'e6d4e3b55cd88af92749d93e388a99045bcdca9cf0a174996b853b628cf6140f',
  'app/api/doctor/schedule/route.ts': '9c1a688d9237d21063a3998fac4c82a8b2c8be7ba2bbedc453662c3e25a68ef1',
  'app/api/internal/analytics/v1/pre-consultations/route.ts': 'c905931774057925d54f2d80cfefef5b3b9afdd07a795e424c7f8a807ed0c52e',
  'app/api/internal/appointments/auto-complete/route.ts': 'ec185028f49b27febbd5dbdb4c673907e77d202bd42d65b960aefc2053d343de',
  'app/api/messages/conversations/route.ts': '15936436b0b3446416a1e4c6f6989826b0165fc3ac8e20f9f3e237a6fb0e46a1',
  'app/api/patient/appointments/[appointmentId]/accept-reschedule/route.ts': '77e224e1b5f3493115b46d76b98bef327b42ca92e60fd8af73d07cbd6c76ea09',
  'app/api/patient/appointments/[appointmentId]/cancel/route.ts': '77e224e1b5f3493115b46d76b98bef327b42ca92e60fd8af73d07cbd6c76ea09',
  'app/api/patient/appointments/[appointmentId]/decline-reschedule/route.ts': '77e224e1b5f3493115b46d76b98bef327b42ca92e60fd8af73d07cbd6c76ea09',
  'app/api/patient/appointments/[appointmentId]/payment/route.ts': 'b516b950696f54d62381ed0fdfdfddc54427e264b1785bf26ac2d7016185a526',
  'app/api/patient/appointments/[appointmentId]/reschedule/route.ts': '77e224e1b5f3493115b46d76b98bef327b42ca92e60fd8af73d07cbd6c76ea09',
  'app/api/patient/appointments/[appointmentId]/vitals/route.ts': '0d3a71e60337f6607b678adba8bd3b858c814d006729a71cd25f8b2108f456d3',
  'app/api/patient/appointments/route.ts': '9c1a688d9237d21063a3998fac4c82a8b2c8be7ba2bbedc453662c3e25a68ef1',
  'app/api/patient/dashboard/route.ts': '2b794449aecdd21865684e890b9add1e5b196c46a31f81b5ac842aabb2fb33e2',
  'app/api/patient/doctors/[doctorId]/availability/route.ts': '94b253ca9f5d600e2c6f6402ea85ad3d8953050d72cf13ff5f5acecce93d00a6',
  'app/api/patient/doctors/route.ts': '62310fa9c2d8e19957698f861d7e2902c2edfaed3bf527d1b4f88f5ca08b25c1',
  'app/api/patient/documents/[documentType]/[documentId]/file/route.ts': '286bcfa82acadbbfaa1b6bfb428586b944842e84602adfeebc39922ebe9fd5aa',
  'app/api/patient/documents/route.ts': '70b63e78117acacfb4accb12c8c1db5e40793309887f06a8eac04d38947972d4',
  'app/api/patient/ehr-access/end-session/route.ts': 'e3a198806194934c2c61772e024291adc3e91491b2ca1b4d4673d65579195b7c',
  'app/api/patient/ehr-access/face-capture-sessions/[sessionId]/complete/route.ts': '24ba6af703e227548d725a714c56cbed13c5b3fb7cf20b0491ef99136f67ba47',
  'app/api/patient/ehr-access/face-capture-sessions/route.ts': '91d41fd989a9c4ea99f957228c56a2060ae0dd8b403b4d05178cf3a54b278bf4',
  'app/api/patient/ehr-access/session/route.ts': '3f3898d3c3bce45fb96e2b81b340f9b7d3759db51a56aa540871ce3690e34d71',
  'app/api/patient/ehr-record-notice/route.ts': '5e70d6c57791b9d92941ad5f725391b7318f3e51df3cfa12fee88bc950325873',
  'app/api/patient/files/[recordId]/file/route.ts': '286bcfa82acadbbfaa1b6bfb428586b944842e84602adfeebc39922ebe9fd5aa',
  'app/api/patient/files/route.ts': '41f32e2993c23fead0a78700816755935ac496bc7dc0818b502941478705bdc0',
  'app/api/patient/health-records/[section]/route.ts': '585ff3bbb62b0efbc1b44f0f0b94484251c2f0c0185d81f92ea7892a5106cfda',
  'app/api/patient/health-records/catalogs/[catalog]/route.ts': 'c2ad79dc0ccef3275e1fdcece33a7b2e653629fe13ae0b9a3abd1b7c6a755f4a',
  'app/api/patient/health-records/route.ts': '70b63e78117acacfb4accb12c8c1db5e40793309887f06a8eac04d38947972d4',
  'app/api/patient/profile/onboarding/route.ts': '631c318a71462fe2496339b032b4a9098991edea74b79e3479c264426c975d58',
  'app/api/patient/profile/registration/route.ts': '63421110a0afff6de6e543b4eb14fa8ec189e89a1137a1752d95a47989466c36',
  'app/api/patient/profile/route.ts': '9d0dd6681fbc06d4464a203f9da5cdfe295e9c3658fde3103bf2374832c35e33',
  'app/api/patient/records/operations/[operationId]/route.ts': 'c8b8003bde8ed6c87373b7ffabab89db6fbe4673d79118d1b01fe25c607a4fd7',
  'app/api/patient/records/route.ts': '41f32e2993c23fead0a78700816755935ac496bc7dc0818b502941478705bdc0',
  'app/api/patient/route.ts': '45529e980b0e2a99e57deb8ec9e048da7b699a9f964d410a05365681667cdae0',
  'app/api/ph-address/route.ts': '376119a1a770b416a1d76efa81e56d21061ddd33f99e4893a5a3238a2c10bd8b',
  'app/api/test-support/e2e/credentials/consume/route.ts': '6e39c681e7ea32d3f0b18fc733d7377e0880b3af1490ea7a49f0e48ef11fab63',
  'app/api/trace/departments/route.ts': 'd2306c44a054a97865343d2153ea34aa3e2e2684d4dab955b45a7163d34d3190',
  'app/integrations/v1/appointments/route.ts': 'abdbd0d72647c50059fcb1f1678286bb7636048492be93715e490a19a86b7175',
  'app/integrations/v1/doctors/route.ts': 'd11076efaba62e7ebc23ed11bc4f9718bb6ef6960c49bdf536447203306b71ac',
  'app/integrations/v1/medical-certificates/route.ts': '8c4da06509127994e10d02035a90b64727f3c470f5699bff1b963f3e394147f0',
  'app/integrations/v1/patient/appointments/route.ts': 'e3dd75935c66d90bc07d04d94bd393d387f97e89d80210a589ecd15a17efd6f9',
  'app/integrations/v1/patient/bootstrap/route.ts': 'b414996a9d2d6ce72aba99e3c0a68d3b2107e4c630561b12a372cefbfd799d27',
  'app/integrations/v1/patients/route.ts': 'd58b8aa4a31c090024f92bfda5eb74360e50877df97d84319eb0a46b816628bb',
  'app/integrations/v1/prescriptions/route.ts': '2c1bcd6627113ac217b81a002248ffe69e0ce82629a91c85840b1c4b057d9219',
  'app/internal/users/[user_id]/roles/route.ts': '1ec836806535d438ba3068da48ed42327adff1ff3ea13302a54afa30418fa935',
  'lib/admin-management.ts': 'be8b25f64d57dbdce885cf1731af13c2bc485b70631d4c18eea43c2cbdedfd80',
  'lib/allergies.ts': '90c0767d3818cc6dea00d19dd374b35b40f08aae2421f38c88553c0d49e13ff1',
  'lib/appointment-action-state.ts': 'bb725cb2a1956750493e931e8c137adc222a4bb6e3684d25f9ce4cd3ba6249aa',
  'lib/appointment-lifecycle.ts': 'b4c5cec819a9e80d835bbcd6abe146730cf267115ee46dceeaa34ff7197fe49e',
  'lib/appointment-serializer.ts': '37b968b4c9df7dd4bdff6960a5142ae1759e81935d036ffd3f3032c041e586ad',
  'lib/auth-error-response.ts': 'cd64d0baf1d6709bdb15ba4f79d5630799f5bc679ccc0c18b384324f0702a089',
  'lib/auth-errors.ts': 'fd4ecbbce99bcd47423a074274dc9ef9bf81843a031d8eca07b1d17731739aff',
  'lib/auth-profile-format.ts': '7b747465ce29a41dabd9cfb06927e90a1eeca55c66d8f9fe1ec28510d0a6f27d',
  'lib/auth-profiles.ts': '4dc2dd0ab6631a7c28fe6d08976b3f3273342a171837f2fb8af3a20cf4cdfb14',
  'lib/auth.ts': 'd7e4b7b7202b8dcbeaf4ce44eb69afba2b45b12cb205e47e8988a2728fdb63e6',
  'lib/client-session.ts': '90a7b17e793db9bf39bbda97fba336cb695b1f655c1c769c4d2434ed07369e6c',
  'lib/cn.ts': 'e05155c088aebc65066f00d1d3bcf556509d157e15c62c99ba391e58b28692e6',
  'lib/cookies.ts': 'ca53e11a9b83c462fecd2ee4eae8d2a4d41edccbde507f96af689645d9e9e359',
  'lib/date-block-matching.ts': '284b1f3d2d6bbd5c11029ad1374321365a958be35d175d8de1328e42b8111f3b',
  'lib/doctor-date-blocks.ts': '43dcc61c355369720e333f723c7a389c019d5af84cfebe7c386de893033f57a2',
  'lib/doctor-record-snapshot.ts': '2ba93c05d22b00b4e7738d97b10156156a7761c9076184642efd994fca66144e',
  'lib/document-records.ts': '5e2d1d816b806838f9e6226035ce79a1db647c96875a9371c75098f8fa827753',
  'lib/e2e-test-support.ts': 'b88ec8a7e3f6f5e9c7ac42219c116a9fb9e722b3c6515fc80e5dee1f49fa09d9',
  'lib/eda/appointment-bff.ts': 'ab84801549e15127e373c96ffdd0ac3076c791f3ceab35d6601e32368d7b1428',
  'lib/eda/appointment-compatibility.ts': 'bb84e542b4c754db09f857711e6a0480e74cb264291e41347d206b7893ed256d',
  'lib/eda/appointment-extras-bff.ts': 'b0e31ec24874fd441899dd3364107d2c893f3dcf7bcdc82169eb98881a9469ef',
  'lib/eda/appointment-paths.ts': 'e7c73aadc99e730c5b7ea4993624d0a8f1791f1423f190e1efdcef428f21d212',
  'lib/eda/appointment-read-bff.ts': '5176f380bd34b3e760638e7d6b8d7cdeff2b0a39c1ae86146a9569b60b8ea7e4',
  'lib/eda/appointment-read-dto.ts': '9c644f8b4c02a65d3c834a3fb3acdbbe743361fa49e8e94e6b8d811a57c8f958',
  'lib/eda/candidate.ts': '94f79ef985d6ff3301f3c902871b912d77229039bcbcc8d8ea56c7625b649115',
  'lib/eda/completion-bff.ts': 'ce3c9a12dce7089ae765f411be29130dd90663579bd51c7bd96bd20355e91a94',
  'lib/eda/completion-consent-list.ts': '7dad713da1ae78a1d6efeaf2ea8722ef9ce4c8443db4e3201e61382185996175',
  'lib/eda/completion-dto.ts': 'a5b4371edd03475500238a48e0e2721f5956a530258a60d3cd342339e7f9ccfe',
  'lib/eda/completion-export.ts': '86253ac46aff7904b418b578799025eb6055e7cc3b5a6cac71518f1c49ac9fad',
  'lib/eda/completion-notifications.ts': 'b844911b583f02ac9ed86bbfa5edf6bc40ccac14e7483e5eff0d08f8d5385a28',
  'lib/eda/completion-paths.ts': 'c4707d7717bb7bc82ff65e68b24ac80efa58079d32673bcd1222f685869a101e',
  'lib/eda/completion-route-policy.ts': '8cfc1d8bbe3bbc94efea2aa3914ea6647ef2b8909f05ccbfb6756e5fef344e52',
  'lib/eda/messaging-bff.ts': '9a2e15ee25df1dddaabcc43c189f7bfe91a62f366004a8d742abbef78eba02e8',
  'lib/eda/messaging-dto.ts': 'a19a285c5b33f21c991c0762177bf8c750974a83ee670e668d845667bb2932ef',
  'lib/eda/messaging-paths.ts': '320185fde0904df6ac25828bebe20dd3a2a126138eac68b0980d5c7988dcced5',
  'lib/eda/messaging-route-policy.ts': 'f8fe5c61d6c5f7105e0fe9241816258bc5a63fb27ef37708831e7cef332b5e94',
  'lib/eda/messaging.ts': '1ce8421f0dbd074d669eaf85d5ee119f2a98cddcfd62efb74e9b9c8b5ceb9cd9',
  'lib/eda/mode-policy.ts': '2f7aa4aa85051b55e2970fb9f4e2bf47aa1a18189d91b7a4c59665cd162c905e',
  'lib/eda/patient-onboarding.ts': 'bf14670643dc52a6693e4bb8ea452b247b43834246196f28554d9686673e092d',
  'lib/eda/patient-record-notice.ts': '966b336c56669936b94c6470a6598802335f0509f562e2373142f841a97db35c',
  'lib/eda/patient-workflow.ts': '81de5bf45249c1d71da5f7df9fda58866fcbd3a998cc5ca50e4b01b277533f4b',
  'lib/eda/payment-bff.ts': '0935b4039d1056f0ee287bdd03a82c798343086d65908027cf4020c3ad5181e9',
  'lib/eda/payment-dto.ts': 'ee9aa64efb28fefeaa17c51695e06347d7cddfb174fa09046de7de82e4ffb496',
  'lib/eda/payment.ts': 'f108996aaaaef9917b8ae6cc687110f73b3e72e3b7823b0625cff647718fa0d0',
  'lib/eda/portal-doctor-provision-bff.ts': 'e46457affc9e1bd0d3a961244f660ecf7ec4a284380b8fbdeddd16f86201fd96',
  'lib/eda/portal-integrations-bff.ts': 'dda2d97d0d68d37082db6ebf3d2fc761cb9624a8e8f097241c28b46f201effcf',
  'lib/eda/portal-integrations-paths.ts': '9834b51150d903c8a159aba811b80fee23af252118ad7a93e2833d8669bb391b',
  'lib/eda/portal-integrations-route-policy.ts': '06fc03af6b23eae65c85848b971a5c9c4b50b6040ce1d52de9f52d4fbaf1a8da',
  'lib/eda/profile-dto.ts': '5dea4b0ac6a26b51b74f33bd3fa855172ba1677dd9f614a290d6b9f777a76c14',
  'lib/eda/profile-mutations.ts': '02749a70c7e61e19bed82811fc33c47694ae38ac9d4e014a0c70d8007292af47',
  'lib/eda/profile-paths.ts': '2c12095977c5250ebc9bd20248c1c481201c28e79b410f5a9ec8776bfb1a01d4',
  'lib/eda/profile-qr-bff.ts': '747fd3ba19c1a4f4a9f30a706d6680226bf11dc99419f03a91d586f4fafff422',
  'lib/eda/profile-qr-paths.ts': '7be7aa43b0faa6845459f386f2ed701eb72263734e586f74c76f6f1d067ff67c',
  'lib/eda/profile-qr-transport.ts': '7ebc4662fc1795cc8dbfa51e742daf2bcebc7f0fc33f0d5fd71e7c100c4f9ba5',
  'lib/eda/profile-qr-upload.ts': '5af7ab231a9d1561643825e7a243935a83c406e395b298fb77bcbbc79721d2b4',
  'lib/eda/profile-registration.ts': '07ca27c21521d8a57ea3937d1081688e5719d82be92ab678d2d5b0afccde69f3',
  'lib/eda/profile.ts': '5a24f90e2395480b726b2108c6ba8cb47c49b62673538f761fdc9d5f52ec139a',
  'lib/eda/public-registration.ts': '3a6311d6658488e9ee51a2db0bd839a75c28d05e51bcc008a75c830283ea86d0',
  'lib/eda/records-bff.ts': '253eba1d0b3000d23025cb715d4017f7b53aebf0468bff666ebfdfbb634991a7',
  'lib/eda/records-composition.ts': 'd6d1fbd8c967eabea562ed1288a3023478043c426be99bfacdddec9259005aee',
  'lib/eda/records-dto.ts': 'a3bb99ac73bd619682d4bb127bef7af8cea1f1c5fb3480761cfad9c36394d060',
  'lib/eda/records-pages.ts': 'f2388350181fda90fad0d33a3ad9876dc69d4ff082cb6845c7bc8295ecbe3f18',
  'lib/eda/records-paths.ts': '98275405c5f099bf31839df594fa7836adcdad879cb602c8eadd2953e178ec04',
  'lib/eda/records-upload.ts': '9d5b67bb5407ffe2a96fd36a27b724147ea57176586ee94796adc1a7af34cbac',
  'lib/eda/records.ts': '26da670d769ba6d5c77d52958d04bfe71e5123aac7c476a72b473e89db8d3204',
  'lib/eda/request-body.ts': '7a78782d69c435e689b110eee50541ed73795c6bfcdb2aaa43ca6da10c71b0d5',
  'lib/eda/stream-bff.ts': '2fa4d988f94763e0876d4b4995c843c155846c1a61dd96ad537fed6ed01e32c7',
  'lib/eda/stream-transport.ts': 'ada0197f643603eb27a9659728a2629b0301ea96e81477afa5b737730037fd5d',
  'lib/eda/transport.ts': 'e0cf41b5b042bb28e594628459dc66dec31d8ee32825a1e9c7db8ec0abba3a1e',
  'app/api/internal/vital/readiness/route.ts': 'b7ffb181f5babb03300373584259088eb10b1d57494b09f579d93aa5183a0877',
  'tests/eda-readiness.test.ts': 'a37c0db033d0143465be8faf2472406e4a4ed75cb86000c6947ee1591cb2c16a',
  'lib/eda/video-bff.ts': '81021e8f76361365a7ebb5432b1242fffc5012b14196020f701fe732ee1811bd',
  'lib/eda/video-cookie.ts': '9c6a2a2f6510515aa225707a74448290a1cb1cb453e76e43b15ac5d6ffdd0842',
  'lib/eda/video-dto.ts': '1ac02c25a9a08dcfe9fa83ec8e85dc04eb69b52b03fe8efb268545643c0171fe',
  'lib/eda/video-paths.ts': 'f2f77f9361e32380196ae336d818ca19572ba599f04095e89bef5e73873cf5ff',
  'lib/eda/video.ts': 'c5b730aacb865400771b9a14a8cad335965c66faac246ec17c69788710519244',
  'lib/ehr-biometric.ts': '4544df66fc21d89ce924aedfa6ac9e59c366b1827092087abd4c7a6201415079',
  'lib/ehr-integration.ts': '42653855fc0680810d0e7db09338f615de7a51bb586a937b69bc9bc06b333231',
  'lib/env.ts': '0731baabb0d884e77bde3c9f00e3a15597c8f78bbf86db7a19343053a1b5be70',
  'lib/errors.ts': '1a56a8260cb8c4aa692f6a4afcda8dadcb8f9a1286329d4fe8faea103a0699b9',
  'lib/form-validation.ts': 'db741005df1df3fd7c186ccd5c89780d18a476ba1a3ed9f2d059ce1afe3bb383',
  'lib/gateway-actor.ts': '620521eeac45bd4b96ed0512b214bf46dc730d83aac4258a10fad6041c651cbe',
  'lib/gateway.ts': 'e564b631fad77d2da3f2cfa19e89c0daaf131de61d94c4a565a09f25a6731ea4',
  'lib/integration-api.ts': '4caf30db294223e2610a701fe042f11a9be156a9a0b0fb1059493ad8dbdadf42',
  'lib/internal-auth.ts': '246c4562bd5d4ddf35b2366f49c5124b01781d8ebd81e8b91f21bcc0fa1a73aa',
  'lib/jwt.ts': 'acb2d4cb6353e2468244997729abe9d838e6677023ce9cc0a0509cfe2bd394d7',
  'lib/meeting-links.ts': 'e39d6c6ab7f3072022ff2578dd6cc6a379f414720278c96d6c02efdcf6c4e672',
  'lib/opqrst.ts': 'b96dec300919159a06bfeea6c22c8420ae907c10153d703789591352234eb4bc',
  'lib/password-policy.ts': '49bbe4b4ee4515747b42d0791625efbb669fe8930d5d53ebf38bd97558242142',
  'lib/patient-appointment-projection.ts': '74d973002eec5ec992bdf81852d4e10fe3c0998cb5dca7e91193f479103c0ffc',
  'lib/patient-booking.ts': '05757183a811861c777eb4dc05a1c110cf251c6f09020333a7cdd313fd770f70',
  'lib/patient-file-open.ts': '80a5a0a0ef634598fbb1aff73055c3cede7b687ca70f646c0a7021a5d0209940',
  'lib/ph-address.ts': '62d896dcfc81323f9f03aade96b908103504c1a39bf8d7e245e4089c35f0b9dd',
  'lib/profile-operation.ts': '6c0191f1023ba0cddda195bcbae6d9738a2c40da68656e4fb78c5c701e868158',
  'lib/reschedule-usage.ts': 'd6439cfd0e9fad61fb4b46d4a5026db351ae70b65d1c78f8ef90ff3a4c6f94d8',
  'lib/route-access.ts': 'ef5e8cd9f54f117214c5adfa08a7ad03753eba957efd781e20f35ea2df738c96',
  'lib/schedule-format.ts': '7dd0decb52f27260ebd1b2d8cf1fd599213f4e831f16f30fd36786f21dde9320',
  'lib/server-auth.ts': 'e613c514c8b0309b10ab1deaf9211a0d211e831a49eef5044e341e83caa2e9af',
  'lib/server-logger.ts': '0049707338533fca27a8049054f89f0c345dd48d54c46ae06dede3dd975c4c82',
  'lib/server-rbac.ts': '9ae2feaab1a9ed2e4e8348f287a083bf89751f49fb406e55c60677d366423614',
  'lib/session-response.ts': '87792f33813bf642f3657b059596799b0a86127fff1c888e57d271a4d0778f53',
  'lib/sso-return.ts': '0b6cd46792948116fca7d14ea69a6af7b1a4981734f77b211e5ee27fb7fd83db',
  'lib/sso-session.ts': '3d59568747c6a36d8f0fa244a53090be47cea4f0b1c6b9bc1437cb1d623c17c6',
  'lib/trace-departments.ts': '4583f5f375c5ac62eca01700f15c63f893eb38851f78951d7b96e3e8dba235a8',
  'lib/useAuthStore.ts': 'df13c11221360a3eaf70baa3f40150c50813fde91ecd660723ed7e1a5d16b946',
  'tests/admin-management.test.ts': 'ccb365d7a630cf90341a7e754d12745db1280a6b7a479c99a0214f0ca5a32ec9',
  'tests/allergies.test.ts': '7f57fecb3c9f0a3a8d9389ababb33e9ef3b33d3e884b02bbcaf30cfc176038ac',
  'tests/appointment-error-safety.test.ts': 'ffb7c25110823cc4916bd1001bfdca2ef5b11c71d30facfd1aea5b2614525676',
  'tests/appointment-lifecycle.test.ts': '3a009196eca70ed89f3a179bdb0ce8bb93e1e1f2aae869b4e8aceb15a87e1780',
  'tests/auth-policy.test.ts': '55152365150a54b9dea6e1024f91e8fea3f771033fbecef0d4d3ed96b08d2394',
  'tests/bff-auth.test.ts': '60f12d85cfb5797cf89ac2d7ef641005371b85d560db12d827ec02ec6bad215f',
  'tests/cookies.test.ts': '9567dde1197dbc60db88e3d1a5bf5b9d0ffbd6375d0037f6ac5b6705055797af',
  'tests/doctor-date-blocks.test.ts': '4991273d672bb454e2ff719137231b358fbd5a271d1d58d76f2444627abc61fd',
  'tests/doctor-record-snapshot.test.ts': '25eb2b06571fbd9469fdb75ce877b4f52cd592277f05f725fbb3b0c6f40f7f01',
  'tests/eda-appointment-compatibility.test.ts': '7f7090c216e2b5457585ae6a8630586c5cf50386bca40287e01268a205632949',
  'tests/eda-appointment-reads.test.ts': 'ec6e49441f866d2c0c58ff8394c1715c71a89d6e41f8e8f5e885c1d7b245d2fe',
  'tests/eda-appointment.test.ts': 'd9645cfa0f47c71b1880682fe84808d70c8d7f1ab7f3861c8735f8c7559b2420',
  'tests/eda-completion-aggregates.test.ts': '4cf46abe207cb2083e1e596557eb22f9c192450bc1b515335597673a00711ea8',
  'tests/eda-completion-qr.test.ts': '4c1007221ad06faafd0a0bee22913629d7c6bb73c5563a857fd7789509bd0257',
  'tests/eda-messaging-bff.test.ts': '98edb7117634d8fb8199f6e66a22470c58a8aaaf74a8568ad23ebe536543defd',
  'tests/eda-payment.test.ts': 'e9e3df2b5b1b88903650779452ce6c01c49a6aedf48d955885641530551c465d',
  'tests/eda-portal-integrations.test.ts': '5004daa0090ab3bca517324db46ca7774c5832a67d5c9b88cf9c76a5cce41dab',
  'tests/eda-portal-provision.test.ts': '85d6a68fd3e93320b6b9d0fd48cc064514dc6d01045f65c6731d65a1f6b9d5a1',
  'tests/eda-profile-boundaries.test.ts': '5389dec91bc24146cdb465fd23b2409fe60ef7d334e74c1901a7c677ae4e2813',
  'tests/eda-profile-registration.test.ts': '363586ec8db429bcbcb0a86bc42f074c3ecb259d61e1eae1f92dbed9998dc5d5',
  'tests/eda-profile.test.ts': '6b2bf74dedd0ab35b1e242c8edc828b510f7c8e7019ae17231c2386a10ebe47f',
  'tests/eda-public-registration.test.ts': '66c48ccd6e7d5a7e76aa3f2893777deab6f3ed58cc59663c3feffd5008d3b4a0',
  'tests/eda-records-pagination.test.ts': '18a990da29ef3ef05cb9c1cc7ae2f846bcd5bc20a827a3c51d8262411d4cd2db',
  'tests/eda-records.test.ts': 'f0025286ea690d5b2b6217199b2cef8926e6a3a8b91559d337e41b0cde11c8c0',
  'tests/eda-remaining-owners.test.ts': '75d1630e63af3ea1066a08ad2f3eb07e1f2cf425a8aadff0565a88b3666a8582',
  'tests/eda-sse.test.ts': '1fb489e045e2b0a4b57bd48071ee92b22a32a421107dd7042036aeedae69c2d2',
  'tests/eda-transport.test.ts': '25f3d47329eec6ec7063de4a39e3b6999922e9a792dae96d8f750d266718e276',
  'tests/eda-video-appointment.test.ts': 'f0fb5b22446153a5a0416b5c14c1ee46a4df2863716392aeee259d3eb5ab49da',
  'tests/eda-video-transport.test.ts': '2259404aca880daadfc6d48244276c95fb4a526c0653f977a0a463bf56748517',
  'tests/eda-video.test.ts': '1f8958f5b8bc183e5ca61018df3f3ea2cd0784d61011e36e845bdf85a660b729',
  'tests/eda-bff-ownership.test.ts': '3981a10d60aaccda56fdb205175d5d9d42b9fe1819edfe0ed8b5ae481502385b',
  'tests/ehr-biometric.test.ts': '9271eb1e12c930c38c68e06edfb4adc5d556355b13dee00972f8884277de2b80',
  'tests/health-records-route.test.ts': '16fc6314dac832a453d6192edbfe9daaeeca4522b3047b3313c15efeba42be0c',
  'tests/helpers/appointment-preparation.ts': '56323a7cdffaaf2a62703683f338d95c3e01ad248f279218869b34c44f1a78ca',
  'tests/integration-api.test.ts': 'bf309efc3a4063a501eb5be3d9f0546a315b9fc59aead6d562f1ed604e96c06b',
  'tests/meeting-links.test.ts': '69a58396b78f126f7f03df6ee6a3e30e81f9c1cd7d3ccf7efbdb7884f018cdaf',
  'tests/messaging-ui-state.test.ts': '8abfb81758b4d3bfaa3a232de4006aef9f27f3d5c6b7a44a005e28062f1c74dc',
  'tests/opqrst.test.ts': '83f76b4829895d7c7123883075997f97758fd9a514c08bcc01ea8aefcebd0475',
  'tests/patient-appointment-projection.test.ts': '00e9a1d727dc83cc44a6225d2a93c99318eebab1d4b9f2257b63d2c044cec9a3',
  'tests/patient-booking.test.ts': '09e994ab12d9400d7cded0fe70d0f0406675b60bba4b40db0e35123ba0cfd187',
  'tests/patient-file-open.test.ts': 'd85ca83ffd7892b84e307ae5e805a258c8b31f56df93824053c9c6ec2b91c629',
  'tests/ph-address.test.ts': 'f8476ae492c7611f07b596a20a6ed9b3b9def79179ea236df29e3f170d3561da',
  'tests/playwright-journey-profile.test.ts': 'f153bc65c948643e75032890d4d908b1ad64e291fce4eb8ea38352c03047cdae',
  'tests/reschedule-usage.test.ts': '28fdbd32f14aadcf440657de1184485e43f4d3892702b5f7aae7300585738aca',
  'tests/retired-concerns.test.ts': 'ee7d029344e984083635dc0d08e757c79b847129d964560ad42b279603363638',
  'tests/session-navigation.test.ts': 'e6ac9c5cbf8d8e0ff44ee9e6488116d667cbbedbfc8a3b236f9d16cda0b5500d',
  'tests/session-response.test.ts': '92bd9fb8904f7347c3d289e3915147e60c723e268ec73f79a48ae4459db45943',
  'tests/sso-return.test.ts': 'b0bb2c334290b63f41c443eb8f099e79b563946f51dc0c442319507d3cfd90b2',
  'tests/sso-session.test.ts': '8020847f102990e7fb0c333b8c3799262631dd4cd6472176cc9fbf759fcde73d',
});

const families = {
  appointment: { owner: 'Services Appointment', entry: 'lib/eda/appointment-bff.ts', dispatch: 'targetAppointment',
    policy: ['lib/eda/appointment-paths.ts', 'appointmentRoute'],
    files: ['lib/eda/appointment-compatibility.ts', 'lib/eda/appointment-read-bff.ts', 'lib/eda/appointment-read-dto.ts'],
    tests: ['eda-appointment.test.ts', 'eda-appointment-reads.test.ts', 'eda-appointment-compatibility.test.ts', 'reschedule-usage.test.ts'],
    request: 'browserAppointmentInput; Idempotency-Key UUID on mutations; same-origin mutations; server command preparation supplies revisions',
    response: 'collectAppointmentRead/decodeAppointmentResponse; legacy lists and command DTOs; processing is not completed',
    statuses: [200, 201, 202, 409], deps: ['Core Appointment', 'Auth profiles', 'EHR identity/case receipt for booking/approval/follow-up', 'Payment checkout', 'Video finalization', 'Records completion snapshot'], flags: ['VITAL_EDA_ENABLED', 'VITAL_EDA_APPOINTMENT_ENABLED'] },
  extras: { owner: 'Services Appointment', entry: 'lib/eda/appointment-extras-bff.ts', dispatch: 'targetAppointmentExtras',
    policy: ['lib/eda/appointment-paths.ts', 'appointmentRoute'], files: ['lib/opqrst.ts'], tests: ['eda-remaining-owners.test.ts', 'opqrst.test.ts'],
    request: 'feedback strict rating 1..5/comment max4000; current revision; opqrst UUID patient; typed intake cursors',
    response: 'feedback receipt or complete paged intake projection; readOpqrst normalizes clinical intake', statuses: [200], deps: ['Core Appointment'], flags: ['VITAL_EDA_ENABLED', 'VITAL_EDA_APPOINTMENT_ENABLED'] },
  completion: { owner: 'Services Completion/Profile', entry: 'lib/eda/completion-bff.ts', dispatch: 'targetCompletion',
    policy: ['lib/eda/completion-route-policy.ts', 'completionRouteAllowed'],
    files: ['lib/eda/completion-dto.ts', 'lib/eda/completion-consent-list.ts', 'lib/eda/completion-notifications.ts'],
    tests: ['eda-completion-aggregates.test.ts', 'eda-completion-qr.test.ts'],
    request: 'GET patientId consent filter; POST strict accepted:true and same-origin; optional UUID idempotency key',
    response: 'completionPatient/completionAdmin/completionConsent; legacy upcoming/statusCounts/notification composition or consent data',
    statuses: [200, 201], deps: ['Core Completion/Profile', 'Appointment composition for patient dashboard', 'notification Gateway inbox'], flags: ['VITAL_EDA_ENABLED', 'VITAL_EDA_COMPLETION_ENABLED'] },
  payment: { owner: 'Services Payment', entry: 'lib/eda/payment-bff.ts', dispatch: 'targetPayment',
    policy: ['lib/eda/mode-policy.ts', 'isPaymentCommand'], files: ['lib/eda/payment.ts', 'lib/eda/payment-dto.ts'], tests: ['eda-payment.test.ts'],
    request: 'empty body only; UUID appointment and stable operation header; POST checkout, PATCH reconcile', response: 'paymentEnvelopeV1; operationStatus and payment projection; pending/unknown is 202',
    statuses: [200, 202], deps: ['Core Appointment authorization', 'Integrations Payment', 'PayMongo through backend owner only'], flags: ['VITAL_EDA_ENABLED', 'VITAL_EDA_PAYMENT_ENABLED'] },
  records: { owner: 'Services Records; EHR clinical authority', entry: 'lib/eda/records-bff.ts', dispatch: 'targetRecords',
    policy: ['lib/eda/records-paths.ts', 'recordsRoute'], files: ['lib/eda/records.ts', 'lib/eda/records-dto.ts', 'lib/eda/records-composition.ts', 'lib/eda/records-upload.ts', 'lib/eda/records-pages.ts', 'lib/patient-file-open.ts'],
    tests: ['eda-records.test.ts', 'health-records-route.test.ts', 'patient-file-open.test.ts', 'doctor-record-snapshot.test.ts'],
    request: 'recordsRoute and strict branch-specific document/snapshot/clinical/upload schemas; UUID identifiers and operation IDs',
    response: 'decodeRecordsV1; legacy documents/files/patient directory/clinical projection; operation receipt or validated file-open response',
    statuses: [200, 201, 202, 303, 409, 422, 503], deps: ['Core Records/Appointment access plan', 'EHR via Gateway', 'Payment authorization for vitals', 'object storage/scanner/rendering for artifacts'], flags: ['VITAL_EDA_ENABLED', 'VITAL_EDA_RECORDS_ENABLED'] },
  recordsIntegration: { owner: 'Services Records; EHR clinical authority', entry: 'lib/eda/records-bff.ts', dispatch: 'targetRecordsIntegration',
    files: ['lib/eda/records.ts', 'lib/eda/records-dto.ts', 'lib/gateway-actor.ts'], tests: ['eda-records.test.ts'],
    request: 'GET trusted EHR reader; POST requireVitalDoctorIntegrationWriter; kind from wrapper literal; allowlisted query or strict document input',
    response: 'typed document list/issuance projection; unchanged public integration envelope', statuses: [200, 201, 202, 409],
    deps: ['Core Records/Appointment', 'Auth identities', 'EHR document operation receipt'], flags: ['VITAL_EDA_ENABLED', 'VITAL_EDA_RECORDS_ENABLED'] },
  video: { owner: 'Services Video (not Auth Google login)', entry: 'lib/eda/video-bff.ts', dispatch: 'targetVideo',
    policy: ['lib/eda/video-paths.ts', 'videoRouteAllowed'], files: ['lib/eda/video.ts', 'lib/eda/video-dto.ts', 'lib/eda/video-cookie.ts'], tests: ['eda-video.test.ts', 'eda-video-transport.test.ts', 'meeting-links.test.ts'],
    request: 'doctor session and current Profile doctor marker; origin on non-GET; strict callback/generation schemas',
    response: 'connection/disconnect/authorizationUrl/generation DTO; callback redirects 303 to fixed settings path', statuses: [200, 202, 303, 409],
    deps: ['Core Profile/Appointment', 'Integrations Video OAuth/provider'], flags: ['VITAL_EDA_ENABLED', 'VITAL_EDA_VIDEO_ENABLED'] },
  messaging: { owner: 'Services Messaging', entry: 'lib/eda/messaging-bff.ts', dispatch: 'targetMessaging',
    policy: ['lib/eda/messaging-route-policy.ts', 'messagingRoute'], files: ['lib/eda/messaging.ts', 'lib/eda/messaging-dto.ts', 'lib/eda/messaging-paths.ts'],
    tests: ['eda-messaging-bff.test.ts', 'messaging-ui-state.test.ts'], request: 'strict message/read/hold schemas; before cursor; same-origin writes; clientMessageId or stable hold operation ID',
    response: 'conversations/history/send/read/hold metadata; no admin transcript DTO', statuses: [200, 201, 429], deps: ['Core Messaging/Appointment', 'Auth counterpart names'], flags: ['VITAL_EDA_ENABLED', 'VITAL_EDA_MESSAGING_ENABLED'] },
  stream: { owner: 'Services Appointment or Messaging SSE', entry: 'lib/eda/stream-bff.ts', dispatch: 'targetStream',
    files: ['lib/eda/stream-transport.ts', 'lib/eda/appointment-read-dto.ts'], tests: ['eda-sse.test.ts', 'messaging-ui-state.test.ts'],
    request: 'GET only; no query; doctor requests or patient/doctor appointment messages; UUID resource and session deadline',
    response: 'text/event-stream; bounded requests/message frames, no-store/no-transform; cancellation and expiry close stream', statuses: [200, 400, 401, 403, 503],
    deps: ['backend SSE owner', 'Appointment/Messaging authorization', 'Auth profile composition for request frames'], flags: ['VITAL_EDA_ENABLED', 'VITAL_EDA_SSE_ENABLED'] },
  qr: { owner: 'Services Profile QR', entry: 'lib/eda/profile-qr-bff.ts', dispatch: 'targetProfileQr',
    policy: ['lib/eda/profile-qr-paths.ts', 'profileQrRoute'], files: ['lib/eda/profile-qr-upload.ts', 'lib/eda/profile-qr-transport.ts'], tests: ['eda-completion-qr.test.ts'],
    request: 'doctor session; no query; same-origin writes; multipart image/provider descriptor or strict isActive boolean; UUID operation',
    response: 'QR list/receipt or hash-verified image bytes; pending is503 Retry-After5; rejected422; never fabricated success', statuses: [200, 422, 503],
    deps: ['Core Profile QR', 'backend artifact validation/storage'], flags: ['VITAL_EDA_ENABLED', 'VITAL_EDA_PROFILE_QR_ENABLED'] },
  portal: { owner: 'Services Portal Integrations/Profile/Appointment', entry: 'lib/eda/portal-integrations-bff.ts', dispatch: 'targetPortalIntegration',
    policy: ['lib/eda/portal-integrations-route-policy.ts', 'portalIntegrationRouteAllowed'],
    files: ['lib/eda/portal-integrations-paths.ts', 'lib/eda/portal-doctor-provision-bff.ts', 'lib/gateway-actor.ts', 'lib/integration-api.ts', 'lib/trace-departments.ts'],
    tests: ['eda-portal-integrations.test.ts', 'eda-portal-provision.test.ts', 'integration-api.test.ts'],
    request: 'trusted Gateway source plus expiry; allowlisted pagination/filters; doctors POST alias-conflict validation and stable Idempotency-Key; TRACE-verified receipt',
    response: 'doctor/patient/staff appointment or patient history/bootstrap DTO; provisioning201; subject and page/association fences', statuses: [200, 201],
    deps: ['Core Profile/Appointment', 'Payment/Video staff projections', 'Auth identities', 'TRACE department on provisioning'], flags: ['VITAL_EDA_ENABLED', 'VITAL_EDA_COMPLETION_ENABLED'] },
  profile: { owner: 'Services Profile', entry: 'lib/eda/profile.ts', dispatch: 'createProfileClient',
    files: ['lib/eda/profile-dto.ts', 'lib/eda/profile-mutations.ts', 'lib/eda/patient-onboarding.ts', 'lib/eda/patient-workflow.ts'],
    tests: ['eda-profile.test.ts', 'eda-profile-boundaries.test.ts', 'eda-profile-registration.test.ts', 'admin-management.test.ts'],
    request: 'route-specific Profile read/mutation; signed scope and resource; stable operation ID on target mutations; see handler for allowed fields',
    response: 'Profile V1 decoder with legacy browser projection; Auth identity and EHR fields remain independently owned', statuses: [200, 201],
    deps: ['Core Profile', 'Auth identity via Gateway', 'TRACE/EHR for bound onboarding/admin workflows'], flags: ['VITAL_EDA_ENABLED'] },
  registration: { owner: 'Gateway/Auth identity; Services Profile registration receipt', entry: 'lib/eda/public-registration.ts', dispatch: 'targetPublicRegistration',
    files: ['lib/eda/profile-registration.ts', 'lib/eda/profile-dto.ts'], tests: ['eda-public-registration.test.ts', 'eda-profile-registration.test.ts'],
    request: 'public registration schema; no browser-selected privileged Profile marker; independently verified pre-OTP purpose', response: 'Auth registration challenge and backend registration provenance, not authenticated login',
    statuses: [200, 201, 400, 409, 503], deps: ['Gateway/Auth registration', 'Services Profile registration receipt/bootstrap'], flags: ['VITAL_EDA_ENABLED'] },
  auth: { owner: 'UHSE_AUTH via Gateway; Web session adapter', entry: 'lib/gateway.ts',
    files: ['lib/auth.ts', 'lib/cookies.ts', 'lib/session-response.ts', 'lib/auth-error-response.ts', 'lib/password-policy.ts'],
    tests: ['auth-policy.test.ts', 'bff-auth.test.ts', 'cookies.test.ts', 'session-response.test.ts', 'sso-session.test.ts'],
    request: 'route-local Auth fields; upstream owns identity/OTP/password/refresh validation', response: 'Gateway Auth result adapted by wrapper; session materialization only after successful identity exchange',
    statuses: [200, 202, 400, 401], deps: ['Gateway', 'UHSE_AUTH', 'Services Profile when materializing a VITAL session'], flags: [] },
  ehr: { owner: 'EHR via Gateway; Web step-up proxy', entry: 'lib/ehr-biometric.ts', dispatch: 'patientAccessProxy',
    files: ['lib/gateway.ts', 'lib/cookies.ts'], tests: ['ehr-biometric.test.ts'], request: 'patient step-up session/face-capture request; upstream validates clinical biometric contract',
    response: 'EHR access response and step-up cookies; multipart capture proxy where selected', statuses: [200], deps: ['Gateway/EHR biometric step-up'], flags: [] },
  analytics: { owner: 'BGH_ANALYTICS via Gateway', entry: 'lib/gateway.ts', dispatch: 'gatewayAnalytics', files: [], tests: ['eda-remaining-owners.test.ts'],
    request: 'admin session; dashboard forwards query; refresh uses POST with system/correlation headers', response: 'upstream analytics payload; refresh202 not completed batch', statuses: [200, 202], deps: ['Gateway/Analytics'], flags: [] },
  export: { owner: 'Services Completion analytics export', entry: 'lib/eda/completion-export.ts', dispatch: 'targetCompletionExport', files: ['lib/eda/completion-dto.ts'], tests: ['eda-completion-aggregates.test.ts'],
    request: 'analytics directional internal service/key; bounded typed cursor/upperBound export', response: 'version1 private page composed to export contract; no browser session', statuses: [200, 401, 503], deps: ['Core Completion/Appointment'], flags: ['VITAL_EDA_ENABLED', 'VITAL_EDA_COMPLETION_ENABLED'] },
  welcome: { owner: 'Web session presentation only', entry: 'lib/auth.ts', dispatch: 'requireBffSession', files: ['lib/cookies.ts'], tests: ['bff-auth.test.ts'],
    request: 'session only; wrapper has no portal-role check', response: 'success/message/data:{role,userId,email}; not a domain read', statuses: [200], deps: ['Gateway session', 'Services Profile materialization when enabled'], flags: [] },
  address: { owner: 'Web Philippine address lookup', entry: 'lib/ph-address.ts', dispatch: 'listRegions', files: [], tests: ['ph-address.test.ts'],
    request: 'public level/islandGroup/region/province/city/district/q query; supported levels only', response: 'success/data address options; unsupported level400', statuses: [200, 400, 500], deps: ['Philippine address data source'], flags: [] },
  trace: { owner: 'TRACE department directory', entry: 'lib/trace-departments.ts', dispatch: 'getTraceDepartments', files: [], tests: ['eda-remaining-owners.test.ts'],
    request: 'any resolved BFF session; no explicit admin requirement', response: 'success/data:{departments}', statuses: [200, 500], deps: ['TRACE protected department read'], flags: [] },
  e2e: { owner: 'Auth test-support credential consumer', entry: 'lib/e2e-test-support.ts', dispatch: 'authorizeE2ETestSupport', files: ['lib/internal-auth.ts'], tests: ['auth-policy.test.ts'],
    request: 'authorizeE2ETestSupport environment/internal-key gate and e2eIdentitySchema email', response: 'temporary credential consumed once; no-store', statuses: [200, 400, 502], deps: ['Auth internal E2E credential capture'], flags: ['E2E_TEST_SUPPORT_ENABLED', 'APP_ENV not production'] },
  readiness: { owner: 'VITAL Services EDA API via Gateway-protected Web readiness wrapper', entry: 'lib/eda/transport.ts', dispatch: 'edaReadiness',
    files: ['lib/eda/transport.ts'], tests: ['eda-readiness.test.ts'], request: 'GET with the Gateway shared secret; no user session or actor assertion',
    response: 'ready or not_ready status; 200/503; invalid Gateway secret403', statuses: [200, 403, 503],
    deps: ['Gateway shared secret', 'VITAL Services /internal/readiness over verified mTLS'], flags: ['VITAL_EDA_ENABLED'] },
  retired: { owner: 'Retired; no replacement dispatch', files: [], tests: ['retired-concerns.test.ts'], request: 'no input consumed; no auth authority inferred', response: 'success:false/message retired', statuses: [410], deps: [], flags: [] },
  worker: { owner: 'Services Appointment maintenance worker', files: [], tests: ['eda-ingress-policy.test.ts'], request: 'legacy HTTP maintenance entry deliberately unavailable', response: 'success:false/code:EDA_MAINTENANCE_WORKER_OWNED', statuses: [503], deps: ['backend worker instead of public HTTP job bridge'], flags: ['VITAL_EDA_ENABLED'] },
};

const rules = new Map();
function add(family, declarations) {
  for (const line of declarations.trim().split('\n')) {
    const [verbs, path, dispatch] = line.trim().split(/\s+/);
    for (const method of verbs.split(',')) {
      const key = method + ' ' + path;
      if (rules.has(key)) throw new Error('Duplicate route review: ' + key);
      rules.set(key, { family, ...(dispatch ? { dispatch } : {}) });
    }
  }
}
add('appointment', `
GET /api/doctor/appointment-requests
GET /api/doctor/dashboard
GET /api/doctor/appointments
GET,POST /api/doctor/schedule
DELETE,PATCH /api/doctor/schedule/[slotId]
GET,POST /api/doctor/date-blocks
DELETE /api/doctor/date-blocks/[blockId]
PATCH /api/doctor/appointment-requests/[appointmentId]/approve
PATCH /api/doctor/appointment-requests/[appointmentId]/reject
PATCH /api/doctor/appointments/[appointmentId]/cancel
PATCH /api/doctor/appointments/[appointmentId]/reschedule
POST /api/doctor/appointments/[appointmentId]/follow-up
GET,POST /api/patient/appointments
PATCH /api/patient/appointments/[appointmentId]/cancel
PATCH /api/patient/appointments/[appointmentId]/reschedule
PATCH /api/patient/appointments/[appointmentId]/accept-reschedule
PATCH /api/patient/appointments/[appointmentId]/decline-reschedule
GET /api/patient/doctors
GET /api/patient/doctors/[doctorId]/availability
PATCH /api/appointments/[appointmentId]/complete`);
add('extras', `
POST /api/appointments/[appointmentId]/feedback
GET /api/doctor/patients/[patientId]/opqrst`);
add('completion', `
GET /api/patient/dashboard
GET /api/admin/dashboard
GET /api/admin/consent
GET,POST /api/auth/consent`);
add('payment', 'PATCH,POST /api/patient/appointments/[appointmentId]/payment');
add('records', `
GET,POST /api/patient/files
GET /api/patient/files/[recordId]/file
GET /api/patient/documents
GET /api/patient/documents/[documentType]/[documentId]/file
GET,POST /api/patient/records
GET /api/patient/records/operations/[operationId]
GET /api/patient/health-records
POST /api/patient/health-records/[section]
GET /api/patient/health-records/catalogs/[catalog]
POST /api/patient/appointments/[appointmentId]/vitals
GET /api/doctor/patients
GET /api/doctor/patients/[patientId]/record
POST /api/doctor/patients/[patientId]/snapshot
GET /api/doctor/appointments/[appointmentId]/vitals
POST /api/doctor/appointments/[appointmentId]/prescriptions
POST /api/doctor/appointments/[appointmentId]/medical-certificates
GET /api/doctor/records/operations/[operationId]
GET /api/doctor/records/files/[assetId]/file`);
add('recordsIntegration', `
GET,POST /integrations/v1/prescriptions
GET,POST /integrations/v1/medical-certificates`);
add('video', `
GET,DELETE /api/doctor/google-meet
POST /api/doctor/google-meet/start
GET /api/doctor/google-meet/callback
POST /api/doctor/google-meet/generate`);
add('messaging', `
GET /api/messages/conversations
GET,POST /api/appointments/[appointmentId]/messages
PATCH /api/appointments/[appointmentId]/messages/read
GET /api/admin/messaging/conversations
POST,DELETE /api/admin/messaging/conversations/[conversationId]/hold`);
add('stream', `
GET /api/doctor/appointment-requests/stream
GET /api/appointments/[appointmentId]/messages/stream`);
add('qr', `
GET,POST /api/doctor/payment-qr
PATCH /api/doctor/payment-qr/[qrId]
GET /api/doctor/payment-qr/[qrId]/file
GET /api/doctor/payment-qr/operations/[operationId]`);
add('portal', `
GET,POST /integrations/v1/doctors
GET /integrations/v1/patients
GET /integrations/v1/appointments
GET /integrations/v1/patient/appointments
POST /integrations/v1/patient/bootstrap`);
add('profile', `
GET /api/doctor/profile
PATCH /api/doctor/profile targetDoctorUpdate
POST /api/doctor/onboarding targetDoctorOnboarding
POST /api/doctor/profile/onboarding targetDoctorOnboarding
GET /api/patient/profile
PATCH /api/patient/profile gatewayUpdateEHRPatient
POST /api/patient/profile/onboarding targetPatientOnboarding
POST /api/patient/profile/registration targetRegistrationBootstrap
GET /api/patient/ehr-record-notice targetPatientRecordNotice
POST /api/patient/ehr-record-notice targetPatientRecordNotice
GET /api/admin/doctors
POST /api/admin/doctors targetAdminProvision
PATCH /api/admin/doctors targetAdminSpecialty
GET /api/admin/users getRoleMembership
PATCH /api/admin/users gatewayJson
GET /api/admin/membership
GET /internal/users/[user_id]/roles createEdaTransport
GET /api/auth/me
PATCH /api/auth/me gatewayUpdateMe`);
add('registration', 'POST /api/auth/register');
add('auth', `
POST /api/auth/login gatewayLoginWithHeaders
POST /api/auth/login/resend gatewayResendLoginOtp
POST /api/auth/logout gatewayLogout
POST /api/auth/refresh gatewayRefreshWithHeaders
GET /api/auth/session gatewayBootstrapSessionWithHeaders
POST /api/auth/sso/callback gatewaySSOCallbackWithHeaders
POST /api/auth/verify gatewayVerifyEmailWithHeaders
POST /api/auth/verify-2fa gatewayVerify2FAWithHeaders
POST /api/auth/verify/resend gatewayResendVerification
GET /api/auth/google/url gatewayGoogleUrl
POST /api/auth/password/forgot gatewayForgotPassword
POST /api/auth/password/reset gatewayResetPassword
POST /api/auth/password/change gatewayUpdateMyPassword
POST /api/auth/me/password gatewayUpdateMyPassword
POST /api/auth/me/profile-picture gatewayUploadMyProfilePicture
POST /api/doctor/profile/picture gatewayUploadMyProfilePicture
POST /api/admin/doctors/[authId]/credentials loggedFetch`);
add('ehr', `
GET /api/patient/ehr-access/session
POST /api/patient/ehr-access/end-session
POST /api/patient/ehr-access/face-capture-sessions
POST /api/patient/ehr-access/face-capture-sessions/[sessionId]/complete patientFaceCaptureProxy`);
add('analytics', `
GET /api/admin/analytics/dashboard
GET /api/admin/analytics/batches/current
POST /api/admin/analytics/batches/refresh`);
add('readiness', 'GET /api/internal/vital/readiness edaReadiness');
add('export', 'GET /api/internal/analytics/v1/pre-consultations');
add('welcome', `
GET /api/patient
GET /api/doctor
GET /api/admin`);
add('address', 'GET /api/ph-address');
add('trace', 'GET /api/trace/departments');
add('e2e', 'POST /api/test-support/e2e/credentials/consume');
add('retired', `
GET /api/admin/concerns
PATCH /api/admin/concerns/[concernId]
POST /api/appointments/[appointmentId]/concerns`);
add('worker', 'POST /api/internal/appointments/auto-complete');

function ast(text, file) { return require('typescript').createSourceFile(file, text, 99, true); }
function visit(node, predicate) {
  const ts = require('typescript'), result = [];
  function walk(item) { if (predicate(item)) result.push(item); ts.forEachChild(item, walk); }
  walk(node); return result;
}
function resolveImport(file, specifier) {
  const path = specifier.startsWith('@/') ? specifier.slice(2) : specifier.startsWith('.')
    ? relative(web, resolve(web, dirname(file), specifier)).replaceAll('\\', '/') : null;
  return path ? path + (path.endsWith('.ts') || path.endsWith('.tsx') ? '' : '.ts') : null;
}
function handler(file, method, read, seen = new Set()) {
  if (seen.has(file)) throw new Error('Cyclic route re-export');
  seen.add(file);
  const ts = require('typescript'), text = read(file), tree = ast(text, file);
  for (const node of tree.statements) {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
      const binding = node.exportClause.elements.find(item => item.name.text === method);
      if (binding) return handler(resolveImport(file, node.moduleSpecifier.text), binding.propertyName?.text ?? method, read, seen);
    }
    if (!node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(node) && node.name?.text === method) return { file, tree, node: node.body, text, chain: [...seen] };
    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations)
      if (declaration.name.getText(tree) === method && declaration.initializer) return { file, tree, node: declaration.initializer, text, chain: [...seen] };
  }
  throw new Error('Exported handler missing: ' + method);
}
function calls(node) {
  const ts = require('typescript');
  return visit(node, item => ts.isCallExpression(item)).map(item => item.expression.getText());
}
function dispatchBinding(entry, symbol) {
  const ts = require('typescript');
  for (const node of entry.tree.statements) {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      const binding = node.importClause.namedBindings.elements.find(item => item.name.text === symbol);
      if (binding) return { file: resolveImport(entry.file, node.moduleSpecifier.text), symbol: binding.propertyName?.text ?? symbol };
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === symbol) return { file: entry.file, symbol };
  }
  return null;
}
const policyCatalogs = new Map();
function policyProbe(file, symbol, paths, method, read, environment = {}) {
  // Only reviewed pure routing tables are evaluated; no BFF/transport or Web runtime is loaded.
  const allowed = new Set(['lib/eda/appointment-paths.ts', 'lib/eda/completion-route-policy.ts',
    'lib/eda/messaging-route-policy.ts', 'lib/eda/profile-qr-paths.ts', 'lib/eda/records-paths.ts',
    'lib/eda/video-paths.ts', 'lib/eda/portal-integrations-route-policy.ts', 'lib/eda/mode-policy.ts']);
  const sources = new Map([...allowed].map(name => [name, read(name)]));
  const catalogKey = hash([...sources].map(([name, text]) => name + ':' + hash(text)).join('|') + JSON.stringify(environment));
  const cache = policyCatalogs.get(catalogKey) ?? new Map();
  const zod = require('zod');
  function load(name) {
    if (!allowed.has(name)) throw new Error('Policy dependency not reviewed: ' + name);
    if (cache.has(name)) return cache.get(name);
    const ts = require('typescript'), output = ts.transpileModule(sources.get(name), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {}; cache.set(name, exports);
    const context = vm.createContext({ exports, URL, process: { env: Object.freeze({ ...environment }) }, require: specifier => {
      if (specifier === 'zod') return zod;
      return load(resolveImport(name, specifier));
    } });
    new vm.Script(output, { filename: name }).runInContext(context, { timeout: 5000 });
    return exports;
  }
  const probes = paths.map(path => {
    const table = load(file);
    if (typeof table[symbol] !== 'function') throw new Error('Policy symbol missing: ' + symbol);
    // Calls also have a deadline; an edited routing table cannot hang inventory generation.
    const context = vm.createContext({ table, symbol, path, method });
    const value = new vm.Script('table[symbol](path, method)').runInContext(context, { timeout: 5000 });
    return { path, method, accepted: Boolean(value), result: value == null ? null : JSON.parse(JSON.stringify(value)) };
  });
  policyCatalogs.set(catalogKey, cache);
  return probes;
}
function ingressProbe(paths, method, read, environment) {
  const ts = require('typescript'), text = read('proxy.ts'), tree = ast(text, 'proxy.ts');
  const proxy = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'proxy');
  const statements = proxy?.body?.statements ?? [];
  const contract = statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText(tree) === 'contractRoute'));
  const guard = statements.find(node => ts.isIfStatement(node));
  if (!contract || !guard || !calls(guard.expression).includes('edaModeEnabled') || !calls(guard.expression).includes('edaRouteAllowed'))
    throw new Error('Reviewed contractRoute/EDA ingress guard is missing.');
  const declaration = contract.getText(tree), condition = guard.expression.getText(tree);
  const policy = policyProbe('lib/eda/mode-policy.ts', 'edaRouteAllowed', paths, method, read, environment);
  return { condition, probes: policy.map(probe => {
    // Evaluate only the actual pure gate expression, never a Next handler or response.
    const context = vm.createContext({ pathname: probe.path, req: { method },
      edaModeEnabled: () => environment.VITAL_EDA_ENABLED === 'true', edaRouteAllowed: () => probe.accepted });
    const result = new vm.Script(declaration + '\n({contractRoute, blocked: Boolean(' + condition + ')});')
      .runInContext(context, { timeout: 5000 });
    return { ...probe, contractRoute: result.contractRoute, ingressGuardBlocked: result.blocked };
  }) };
}
function examples(path) {
  let result = [path];
  for (const [parameter, values] of Object.entries({ documentType: ['prescription', 'medical-certificate'], section: ['bmi', 'allergies'], catalog: ['allergens', 'conditions', 'medicines', 'diagnostic-services'] }))
    result = result.flatMap(item => item.includes('[' + parameter + ']') ? values.map(value => item.replace('[' + parameter + ']', value)) : [item]);
  return result.map(item => item.replace(/\[[^/]+\]/g, uuid));
}
const snippetCache = new Map();
function snippets(file, text) {
  const key = file + ':' + hash(text);
  if (snippetCache.has(key)) return structuredClone(snippetCache.get(key));
  const ts = require('typescript'), tree = ast(text, file);
  const result = { validators: [], statuses: [], errors: [], cookies: [], dependencies: [] };
  for (const node of visit(tree, item => ts.isCallExpression(item) || ts.isPropertyAssignment(item) || ts.isStringLiteral(item))) {
    const source = node.getText(tree), line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    const evidence = { file, line, source: source.slice(0, 700) };
    if (ts.isCallExpression(node) && /(?:\.parse|\.safeParse|decode[A-Z]|readProfileBody|readRecordsUpload)/.test(node.expression.getText(tree))) result.validators.push(evidence);
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'status') result.statuses.push(evidence);
    if (ts.isStringLiteral(node) && /^(?:EDA|PROFILE|APPOINTMENT|PAYMENT|RECORD|VIDEO|MESSAG|SSE|COMPLETION|PORTAL|COMMAND|ACTOR)[A-Z0-9_]+$/.test(node.text)) result.errors.push(evidence);
    if (ts.isCallExpression(node) && /Cookie|SessionHeaders|materializeVitalSession/.test(node.expression.getText(tree))) result.cookies.push(evidence);
    if (ts.isStringLiteral(node) && node.text.startsWith('/internal/')) result.dependencies.push(evidence);
  }
  snippetCache.set(key, result);
  return structuredClone(result);
}
function walk(directory, root, output = []) {
  try {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const file = directory + '/' + entry.name;
      if (entry.isDirectory() && !['node_modules', '.next', 'generated'].includes(entry.name)) walk(file, root, output);
      else if (entry.isFile() && /\.(?:ts|tsx)$/.test(file) && !file.endsWith('/route.ts')) output.push(file);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return output;
}
function roleFor(path, method, family) {
  if (family === 'retired' || family === 'worker') return 'none; endpoint unavailable';
  if (family === 'readiness') return 'Gateway service probe; no patient/doctor role or user session';
  if (family === 'welcome') return 'any resolved session; URL role label is not a role check';
  if (family === 'portal') return path.endsWith('/bootstrap') ? 'UHSE guest/EHR patient/VITAL guest or patient; VITAL membership'
    : path.endsWith('/patient/appointments') ? 'UHSE guest/EHR patient/VITAL patient; VITAL membership'
      : method === 'POST' ? 'EHR admin or trusted platform SuperAdmin' : 'EHR nurse/doctor/admin or trusted platform SuperAdmin';
  if (family === 'recordsIntegration') return method === 'GET' ? 'EHR nurse/doctor/admin or trusted platform SuperAdmin'
    : 'VITAL-system doctor plus same-subject doctor session/Profile marker; no SuperAdmin-only bypass';
  if (path === '/api/auth/consent') return method === 'POST' ? 'patient' : 'admin';
  if (family === 'address' || family === 'registration') return 'public; no authenticated role required';
  if (family === 'export') return 'analytics internal service';
  if (path.startsWith('/internal/users/')) return 'Auth internal service; configured process subject, never queried user';
  if (family === 'e2e') return 'test-support internal caller; not ordinary patient/admin';
  if (family === 'trace') return 'any resolved BFF session';
  if (path === '/api/auth/me') return 'any resolved BFF session; Auth identity remains upstream-owned';
  if (path === '/api/doctor/profile' && method === 'GET') return 'resolved BFF session; Profile doctor reader checks marker/authority';
  if (family === 'records' && path.includes('/health-records/catalogs/')) return 'patient or doctor; catalog read exception';
  if (family === 'auth') return /\/me\/(password)$|\/password\/change$/.test(path) ? 'bearer token; upstream Auth authorization'
    : /\/picture$|profile-picture$/.test(path) ? 'resolved BFF session; upstream Auth authorization'
      : path.startsWith('/api/admin/') ? 'admin' : 'public exchange/challenge/refresh flow; not a Services domain role';
  if (path.startsWith('/api/admin/')) return 'admin';
  if (family === 'video' || family === 'qr' || path.startsWith('/api/doctor/')) return 'doctor';
  if (path.startsWith('/api/patient/')) return 'patient';
  return 'patient or doctor; owning Appointment participant fence';
}

const requestDetails = {
  '/api/auth/login': 'JSON email/password; trimmed nonempty email and nonempty password; OTP challenge202 vs materialized session200',
  '/api/auth/login/resend': 'JSON nonempty trimmed email; Gateway resend OTP',
  '/api/auth/verify': 'JSON email/code; verification challenge result before session materialization',
  '/api/auth/verify-2fa': 'JSON email/code; Gateway 2FA verification before materialization',
  '/api/auth/verify/resend': 'JSON truthy email; upstream verification resend; no stronger local email validation inferred',
  '/api/auth/sso/callback': 'POST JSON exchange_token, not Google Meet callback, not GET redirect; Gateway one-time exchange',
  '/api/auth/google/url': 'GET next query forwarded to Gateway Auth Google authorization URL; distinct from Video OAuth',
  '/api/auth/session': 'GET requires latest refresh-token cookie, not bearer-only bootstrap; upstream rotates refresh/access headers',
  '/api/auth/refresh': 'POST latest refresh-token cookie; rotated refresh cookie normalization; access token remains JSON',
  '/api/auth/logout': 'best-effort session/bearer/refresh lookup and upstream cleanup; local cookie clearing is not gated on successful upstream logout',
  '/api/auth/password/forgot': 'JSON trimmed nonempty email',
  '/api/auth/password/reset': 'JSON trimmed email/code and new_password; local password policy, upstream challenge verification',
  '/api/auth/password/change': 'Bearer token; JSON current_password/new_password; local password policy',
  '/api/auth/me/password': 'Bearer token; JSON current_password/new_password/confirm_password; equality and password policy',
  '/api/auth/me/profile-picture': 'session; multipart File named file; local wrapper does not bound bytes before formData',
  '/api/doctor/profile/picture': 'session; multipart File named file; Auth-owned picture, not Services artifact storage',
  '/api/admin/doctors/[authId]/credentials': 'admin session; path Auth UUID passed to Gateway credentials/reissue; no Services credential writer',
  '/api/admin/users': 'GET role/search/status/page/pageSize plus Profile membership filtering; PATCH userId/action revoke|restore|unlock and optional isAdmin; Auth owns access state',
  '/api/patient/profile': 'GET Auth/Profile/EHR booking composition; PATCH only contactNumber normalized to Philippine phone, EHR operation receipt and step-up cookie',
  '/api/auth/me': 'GET Auth identity plus Profile flags; PATCH first_name/last_name required, optional middle_name/extension_name, Auth-only update',
  '/internal/users/[user_id]/roles': 'UUID queried user; exact auth service plus directional service key and configured VITAL_BFF_SERVICE_AUTH_ID; generic internal-api-key alone does not grant backend delegation',
};

const referenceCatalogs = new Map();
function routeReferences(path, root, read) {
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escape(path).replace(/\\\[[^\]]+\\\]/g, '(?:\\$\\{[^}]+\\}|[^/\\s\x22\x27\x60]+)') + '(?=[?\x22\x27\x60\\s]|$)');
  const matches = [];
  // Discover call sites once per inventory process; re-read matched evidence so
  // its reported hashes/lines are current. This is not exhaustive UI coverage.
  if (!referenceCatalogs.has(root)) referenceCatalogs.set(root,
    ['app', 'components', 'lib', 'tests', 'playwright'].flatMap(dir => walk(dir, root)).map(file => ({ file, text: readFileSync(resolve(root, file), 'utf8') })));
  for (const candidate of referenceCatalogs.get(root)) {
    if (!pattern.test(candidate.text)) continue;
    const file = candidate.file, text = read(file), lines = text.split(/\r?\n/);
    const linesMatched = lines.flatMap((line, index) => pattern.test(line) ? [{ line: index + 1, source: line.trim().slice(0, 500) }] : []);
    if (linesMatched.length) matches.push({ file, sha256: hash(text), references: linesMatched,
      kind: file.startsWith('tests/') ? 'route_test_source_reference' : file.startsWith('playwright/') ? 'journey_source_reference' : 'caller_source_reference', execution: 'not_run' });
  }
  return matches;
}

/** Synchronous inventory helper. A second argument permits isolated read-only fixtures.
 * reviewed means static source review only. No request, provider or Web test is run.
 */
export function reviewRouteContract(route, options = {}) {
  const root = options.webRoot ?? web;
  const read = file => {
    if (typeof file !== 'string' || file.includes('\\') || file.startsWith('/') || file.split('/').some(part => part === '..' || part === '.')) throw new Error('Unsafe evidence path');
    return options.readSource ? options.readSource(file) : readFileSync(resolve(root, file), 'utf8');
  };
  const gates = [], evidence = new Map();
  const issue = (code, file, detail) => gates.push({ code, ...(file ? { file } : {}), detail });
  function capture(file, kind, pinned = true) {
    const key = kind + ':' + file;
    if (evidence.has(key)) return evidence.get(key);
    try {
      const text = read(file), sha256 = hash(text);
      const item = { repository: 'vital-web', file, kind, sha256, execution: 'not_run', ...(pinned ? { reviewedSha256: reviewedHashes[file] ?? null } : {}) };
      evidence.set(key, item);
      if (pinned && !reviewedHashes[file]) issue('SOURCE_NOT_REVIEWED', file, 'No reviewed source fingerprint.');
      else if (pinned && reviewedHashes[file] !== sha256) issue('REVIEW_SOURCE_CHANGED', file, 'Re-review this file before accepting static evidence.');
      return item;
    } catch (error) { issue('EVIDENCE_MISSING', file, String(error.message)); return null; }
  }
  const path = route?.path, suppliedMethods = route?.methods;
  const result = { reviewed: false, reviewType: 'static_source_review', parityStatus: 'not_verified', runtimeEvidence: [],
    caller: null, authentication: null, targetOwner: null, requiredRole: null, requestDto: null, responseDto: null,
    cookies: null, bodyLimit: null, timeout: null, methods: [], evidence: [], gates };
  if (typeof path !== 'string' || !path.startsWith('/') || /[?#\\]|(?:^|\/)\.\.(?:\/|$)/.test(path)
    || !Array.isArray(suppliedMethods) || !suppliedMethods.length || new Set(suppliedMethods).size !== suppliedMethods.length) {
    issue('ROUTE_INPUT_INVALID', null, 'A canonical inventory path and unique exported methods are required.'); return result;
  }
  const source = 'app' + path + '/route.ts';
  if (route.source !== source) issue('ROUTE_SOURCE_MISMATCH', route.source, 'Expected ' + source);
  const wrapper = capture(source, 'route_wrapper');
  if (!route.sourceSha256 || wrapper?.sha256 !== route.sourceSha256) issue('ROUTE_SOURCE_HASH_MISMATCH', source, 'Inventory fingerprint does not match the current wrapper.');
  for (const method of suppliedMethods) {
    const rule = rules.get(method + ' ' + path);
    if (!methods.has(method) || !rule) { issue('ROUTE_UNREVIEWED', source, method + ' ' + path + ' has no explicit reviewed rule.'); continue; }
    const family = families[rule.family], dispatch = rule.dispatch ?? family.dispatch;
    const before = gates.length;
    let entry, binding;
    try {
      entry = handler(source, method, read);
      for (const file of entry.chain) capture(file, 'handler_source');
      if (dispatch && !calls(entry.node).includes(dispatch)) issue('WRAPPER_DISPATCH_MISMATCH', entry.file, method + ' does not call ' + dispatch);
      if (dispatch) {
        binding = dispatchBinding(entry, dispatch);
        if (!binding?.file) issue('DISPATCH_BINDING_UNREVIEWED', entry.file, 'Cannot resolve the called symbol to a reviewed local file.');
        else capture(binding.file, 'dispatch_implementation');
      }
      if (rule.family === 'retired' && (!entry.node.getText().includes('retired') || !entry.node.getText().includes('410')))
        issue('RETIRED_CONTRACT_CHANGED', entry.file, 'Expected unconditional retired410 response.');
      if (rule.family === 'worker' && !entry.node.getText().includes('EDA_MAINTENANCE_WORKER_OWNED')) issue('WORKER_CONTRACT_CHANGED', entry.file, 'Maintenance must remain explicitly unavailable.');
    } catch (error) { issue('HANDLER_UNREVIEWED', source, String(error.message)); }
    const files = [...new Set(['proxy.ts', 'lib/env.ts', 'lib/route-access.ts', 'lib/eda/mode-policy.ts', ...(family.entry ? [family.entry] : []), ...(binding?.file ? [binding.file] : []), ...(family.files ?? []),
      ...(rule.family !== 'retired' && rule.family !== 'worker' && !['address', 'e2e', 'readiness'].includes(rule.family) ? ['lib/auth.ts', 'lib/cookies.ts'] : []),
      ...(['appointment', 'extras', 'completion', 'payment', 'records', 'recordsIntegration', 'video', 'messaging', 'stream', 'qr', 'portal', 'profile', 'registration', 'export'].includes(rule.family)
        ? ['lib/eda/transport.ts', 'lib/eda/mode-policy.ts', 'lib/eda/candidate.ts', 'lib/eda/request-body.ts'] : []),
      ...(family.policy ? [family.policy[0]] : [])])];
    const facts = { validators: [], statuses: [], errors: [], cookies: [], dependencies: [] };
    for (const file of files) {
      if (!capture(file, 'implementation')) continue;
      const extracted = snippets(file, read(file));
      for (const key of Object.keys(facts)) facts[key].push(...extracted[key]);
    }
    if (entry) {
      const extracted = snippets(entry.file, entry.node.getText());
      // Handler snippet line numbers are relative to its body; preserve the offset.
      const offset = entry.tree.getLineAndCharacterOfPosition(entry.node.getStart(entry.tree)).line;
      for (const key of Object.keys(facts)) facts[key].push(...extracted[key].map(item => ({ ...item, line: item.line + offset })));
    }
    let dispatchPolicy = null;
    if (family.policy) {
      try {
        const [file, symbol] = family.policy;
        // opqrst intentionally uses extras, not recordsRoute or appointmentRoute.
        dispatchPolicy = rule.family === 'extras' && path.endsWith('/opqrst')
          ? { file: family.entry, symbol: 'targetAppointmentExtras', verifiedBy: 'reviewed handler regex and method branch', examples: examples(path) }
          : { file, symbol, probes: policyProbe(file, symbol, examples(path), method, read) };
        if (dispatchPolicy.probes?.some(probe => !probe.accepted)) issue('DISPATCH_POLICY_MISMATCH', file, 'Actual public routing table rejects a reviewed method/path.');
      } catch (error) { issue('DISPATCH_POLICY_UNREVIEWED', family.policy[0], String(error.message)); }
    }
    for (const test of [...(family.tests ?? []), 'eda-ingress-policy.test.ts']) capture('tests/' + test, 'test_source_reference');
    let frontDoor;
    try {
      const environment = Object.fromEntries(['VITAL_EDA_ENABLED', 'VITAL_EDA_APPOINTMENT_ENABLED', 'VITAL_EDA_COMPLETION_ENABLED', 'VITAL_EDA_PAYMENT_ENABLED',
        'VITAL_EDA_RECORDS_ENABLED', 'VITAL_EDA_VIDEO_ENABLED', 'VITAL_EDA_MESSAGING_ENABLED', 'VITAL_EDA_MESSAGE_HOLDS_ENABLED', 'VITAL_EDA_SSE_ENABLED', 'VITAL_EDA_PROFILE_QR_ENABLED'].map(name => [name, 'true']));
      const ingress = rule.family === 'readiness' ? null : ingressProbe(examples(path), method, read, environment);
      frontDoor = rule.family === 'readiness'
        ? { file: source, review: 'static direct-probe classification; not a browser route or deployment claim',
            condition: 'Gateway shared secret at Web; verified mTLS from Web to Services', probes: [], contractRoute: false,
            targetModeAccepted: null, ownerFlagChecks: [], deniedStatus: 503, deniedCode: 'not_ready' }
        : { file: 'proxy.ts', review: 'static all-owner-flags-enabled probe; not a request or deployed configuration',
            condition: ingress.condition, probes: ingress.probes, contractRoute: ingress.probes.every(probe => probe.contractRoute),
            targetModeAccepted: ingress.probes.every(probe => !probe.ingressGuardBlocked),
            ownerFlagChecks: !['portal', 'recordsIntegration'].includes(rule.family) || method !== 'POST' ? []
              : family.flags.filter(flag => flag !== 'VITAL_EDA_ENABLED').map(disabledFlag => ({ disabledFlag,
                probes: ingressProbe(examples(path), method, read, { ...environment, [disabledFlag]: 'false' }).probes })),
            deniedStatus: 503, deniedCode: 'EDA_LEGACY_OWNER_DISABLED' };
    } catch (error) { issue('FRONT_DOOR_POLICY_UNREVIEWED', 'proxy.ts', String(error.message)); }
    const internal = rule.family === 'export' || rule.family === 'readiness' || path.startsWith('/internal/users/');
    const foreign = ['portal', 'recordsIntegration'].includes(rule.family);
    const publicRoute = rule.family === 'address' || rule.family === 'registration' || rule.family === 'auth' && !/\/me\/|\/password\/change$|\/picture$|\/credentials$/.test(path);
    const bearerOnly = ['/api/auth/me/password', '/api/auth/password/change'].includes(path);
    const authentication = rule.family === 'readiness' ? 'Constant-time X-Gateway-Secret check at Web; verified mTLS to Services; no user or actor assertion'
      : foreign ? 'Gateway-secret validated X-User-* source and source expiry; signed scoped Services delegation; no local-role impersonation'
      : internal ? 'directional internal service/key before scoped signed backend request'
        : ['retired', 'worker'].includes(rule.family) ? 'no session authority claimed; explicit unavailable response'
          : rule.family === 'e2e' ? 'test-only enablement and internal caller key'
            : bearerOnly ? 'Bearer Authorization header required directly by wrapper; no cookie-bootstrap fallback'
              : publicRoute ? 'public/challenge/refresh/exchange flow as stated in requiredRole; no requireBffSession inferred'
              : 'requireBffSession: bearer or Gateway cookie bootstrap; scoped Services assertion where delegated';
    let owner = family.owner;
    if (path === '/api/auth/me') owner = method === 'PATCH' ? 'UHSE_AUTH via Gateway' : 'Auth identity plus Services Profile composition';
    if (path === '/api/admin/users') owner = method === 'PATCH' ? 'UHSE_AUTH access/lock state via Gateway' : 'Auth directory plus Services Profile membership';
    if (path === '/api/patient/profile' && method === 'PATCH') owner = 'EHR contact operation via Gateway; no Profile contact writer';
    if (rule.family === 'stream') owner = path.includes('/messages/') ? 'Services Messaging SSE' : 'Services Appointment SSE';
    const row = { method, publicPath: path, family: rule.family, targetOwner: owner,
      caller: rule.family === 'readiness' ? 'Gateway server readiness probe; not browser' : foreign ? 'Gateway-forwarded foreign portal/staff' : internal ? 'internal service, not browser' : rule.family === 'video' && path.endsWith('/callback') ? 'browser OAuth callback navigation' : 'Web browser/BFF consumer',
      authentication, requiredRole: roleFor(path, method, rule.family),
      dispatch: { wrapper: source, handlerSource: entry?.file ?? null, implementation: binding?.file ?? null, symbol: dispatch ?? 'local explicit response', policy: dispatchPolicy, frontDoor },
      requestDto: { summary: requestDetails[path] ?? family.request, staticValidatorReferences: facts.validators, note: 'References include shared family branches, not proof every branch runs for this method.' },
      responseDto: { summary: family.response, schemaFiles: files.filter(file => /dto|composition|compatibility/.test(file)) },
      status: { documentedFamilyBranches: family.statuses, sourceExpressions: facts.statuses, exhaustive: false },
      cookies: { policy: foreign || internal || ['retired', 'worker', 'address', 'e2e', 'readiness'].includes(rule.family) ? 'No session-cookie behavior inferred; inspect explicit source references.'
        : rule.family === 'video' ? 'Gateway session rotation plus HttpOnly SameSite=Lax vital_google_meet_oauth binding cookie; callback/disconnect clear it'
          : path === '/api/auth/logout' ? 'Clear refresh/access/activity, Meet binding and EHR verified-session cookies even if upstream logout fails'
            : 'attachBffSessionHeaders/upstream-cookie behavior is branch-specific; no access-token cookie persistence inferred', sourceReferences: facts.cookies },
      errors: { policy: 'Preserve explicit wrapper/BFF status mapping; typed decoder failures fail closed. Listed codes include shared branches.', sourceReferences: facts.errors },
      dependencies: { owners: family.deps, privatePathReferences: facts.dependencies, note: 'Private version1 page envelopes are not a browser contract change; runtime/private-page acceptance is not established here.' },
      gates: { featureFlags: [...family.flags, ...(rule.family === 'messaging' && path.startsWith('/api/admin/') ? ['VITAL_EDA_MESSAGE_HOLDS_ENABLED'] : []),
        ...(rule.family === 'stream' ? [path.includes('/messages/') ? 'VITAL_EDA_MESSAGING_ENABLED' : 'VITAL_EDA_APPOINTMENT_ENABLED'] : []),
        ...(rule.family === 'completion' && path === '/api/patient/dashboard' ? ['VITAL_EDA_APPOINTMENT_ENABLED'] : [])],
        frontDoor: rule.family === 'readiness' ? 'not_applicable; internal Gateway readiness endpoint, not browser proxy admission'
          : frontDoor?.targetModeAccepted === false ? 'blocked_in_target_mode_even_with_owner_flags_enabled; review proxy before claiming route availability' : 'static routing admission only; live authorization not established',
        runtimeParity: 'unverified; coordinated Gateway/Auth/backend/provider/UI acceptance required' },
      bodyLimit: ['retired', 'worker', 'address', 'readiness'].includes(rule.family) ? 'not applicable' : rule.family === 'qr' && method === 'POST' ? '5MiB image; +64KiB envelope; readProfileQrUpload'
        : rule.family === 'records' && path === '/api/patient/files' && method === 'POST' ? '10MiB file; 11MiB multipart envelope; readRecordsUpload'
          : facts.validators.some(item => item.source.startsWith('readProfileBody')) ? 'readProfileBody default65536 bytes; explicit call overrides are evidenced; not a global route limit'
            : 'not established for every wrapper branch; inspect request reader and upstream limits',
      timeout: rule.family === 'readiness' ? { policy: '3.5s readiness exchange timeout; response limited to 128 bytes; not an end-to-end SLA', establishedEndToEnd: false }
        : { policy: 'Services transport default15000ms configurable100..30000; body reader default15000ms, upload10000ms; not an end-to-end route SLA', establishedEndToEnd: false },
      reviewed: gates.length === before, parityStatus: 'not_verified', runtimeEvidence: [] };
    result.methods.push(row);
  }
  // A removed method must not silently disappear from a formerly reviewed route.
  const expected = [...rules.keys()].filter(key => key.endsWith(' ' + path)).map(key => key.split(' ')[0]).sort();
  if (JSON.stringify([...suppliedMethods].sort()) !== JSON.stringify(expected)) issue('METHOD_SET_CHANGED', source, 'Reviewed exported methods: ' + expected.join(','));
  result.evidence = [...evidence.values()];
  try {
    result.callerAndTestReferences = routeReferences(path, root, read);
    for (const row of result.methods) row.callerAndTestEvidence = {
      scope: 'path reference only; HTTP method and exercised behavior are not inferred from a string match',
      directReferences: result.callerAndTestReferences.map(item => ({ file: item.file, sha256: item.sha256, kind: item.kind })),
      discovery: 'process-local file catalog; restart inventory after caller source changes; not an exhaustive call graph',
      acceptance: 'not_executed',
    };
  } catch (error) { issue('CALLER_REFERENCE_SCAN_INCOMPLETE', null, String(error.message)); }
  result.reviewed = gates.length === 0 && result.methods.length === suppliedMethods.length;
  for (const field of ['caller', 'authentication', 'targetOwner', 'requiredRole', 'requestDto', 'responseDto', 'cookies', 'bodyLimit', 'timeout'])
    result[field] = result.methods.length === 1 ? result.methods[0][field] : Object.fromEntries(result.methods.map(row => [row.method, row[field]]));
  result.remainingGates = ['runtime_route_parity_not_executed', 'Web_UI_journey_acceptance_not_executed', 'provider_and_database_acceptance_not_executed'];
  if (result.methods.some(row => row.dispatch.frontDoor?.targetModeAccepted === false)) result.remainingGates.push('front_door_blocks_target_mode_route');
  result.evidenceSemantics = 'Source references and hashes only. Test source existence is not a passing test result. No production handlers or Web tests are executed.';
  return result;
}
