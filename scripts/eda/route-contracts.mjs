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
  'app/api/doctor/date-blocks/batch/route.ts': 'ab10c50e04e09a6e7b06a4d9b0eb1e9cd28aca592a940bd0462a0c1f9899746b',
  'app/api/doctor/date-blocks/preview/route.ts': 'ab10c50e04e09a6e7b06a4d9b0eb1e9cd28aca592a940bd0462a0c1f9899746b',
  'tests/eda-appointment-revisions.test.ts': '94735aa4450fc203c0b0f7699899bc8a6756aaee868a3102bb4c61e4031bcb6f',
  'lib/eda/notification-inbox.ts': 'c55d34d88fc4109c48043da0d9e02fd1671fda5144deeb7f7a352f114939d3e6',
  'lib/eda/notification-inbox-bff.ts': '13b9aeeed4c2b2f4422642e32b2b3cf5d627d798155fa195af17075b65dfe554',
  'lib/eda/appointment-revisions-paths.ts': '53eea2f02e95178b6d1304e175e5b31761d12401e5cc13573e40cb786134e59c',
  'lib/eda/appointment-revisions-bff.ts': 'a94debfac0cfa3f149e108943efdded712e6540d08d356fb3e3867bf2d65f6b4',
  'app/api/notifications/route.ts': '2cfa24b7cc20971922d304a3c08e1940a9cdb5e7a997ff557c8d408fdf3a1a16',
  'app/api/notifications/[notificationId]/read/route.ts': 'd9118796de4983b47778a22e6fd2717b42ce6770c33dcb467b00c918de825561',
  'app/api/doctor/appointments/[appointmentId]/chief-complaint/route.ts': 'ac475cbe2a7749795dd331fd0bffb9ebe4fbae2294a411d6c68e12cf3a6e09a7',
  'app/api/appointments/[appointmentId]/chief-complaint/route.ts': '5cad957232ae57112581c66a3294e739aad081fd15c63ca5fcde52147039e7b2',
  'app/api/admin/doctors/[authId]/ratings/route.ts': '5cad957232ae57112581c66a3294e739aad081fd15c63ca5fcde52147039e7b2',
  'lib/eda/admin-directory.ts': 'e7663dca00ddb256af96e4f4ca92619281d87b9c580781192df61ab224d3f9a3',
  'app/api/admin/patients/route.ts': 'e36a083c52d0c5d8e7709b01886c82a805e1945a873fe74c48e48fa829b94847',
  'app/api/admin/appointments/[appointmentId]/acknowledgment/file/route.ts': 'e46cd775590bcbb236ae0bb13f0e74bab030ba1ebdb28d9749811715d9a261ef',
  'app/api/admin/appointments/[appointmentId]/acknowledgment/route.ts': 'e46cd775590bcbb236ae0bb13f0e74bab030ba1ebdb28d9749811715d9a261ef',
  'app/api/doctor/signing-profile/route.ts': '2a91db2d0769fc09ce61cefe727cf2f443fd38ab7f0df1e1d6f1a4c78d96025f',
  'app/api/documents/prescription/[documentId]/file/route.ts': '5393bbab074cec8a776a6add7e0c556b1ebf1ff5e257c380e6c67f7dd04524ae',
  'app/api/documents/prescription/[documentId]/route.ts': '5393bbab074cec8a776a6add7e0c556b1ebf1ff5e257c380e6c67f7dd04524ae',
  'app/api/patient/appointments/[appointmentId]/acknowledgment/file/route.ts': 'e46cd775590bcbb236ae0bb13f0e74bab030ba1ebdb28d9749811715d9a261ef',
  'app/api/patient/appointments/[appointmentId]/acknowledgment/route.ts': 'e46cd775590bcbb236ae0bb13f0e74bab030ba1ebdb28d9749811715d9a261ef',
  'lib/eda/acknowledgment-bff.ts': '22722f042e195642e47407441ce8503fab33986b5d04cbf3ee22f8a5949598b0',
  'proxy.ts': 'ff7433c4f8ed9cc2f6ad874dc1085c754d79a991a6b337c76ff1cc33b7928199',
  'tests/eda-ingress-policy.test.ts': '76e048956f619a7903ef986cf8773efac21e5219b8709d076235c0f4af88b691',
  'app/api/admin/analytics/batches/current/route.ts': '8ed67fd1777a6d676558ccfa189c25d050b878b4e655a0970fa7aed57b8bd976',
  'app/api/admin/analytics/batches/refresh/route.ts': 'ee653f60ea2cf0965b837d7384c05c3ca96eae6b628453fae1eebc01919f619f',
  'app/api/admin/analytics/dashboard/route.ts': 'f08bbcf446a205e806a9f61da59f7d60e0318720d09c4cc8a3f00f52f26600b8',
  'app/api/admin/concerns/[concernId]/route.ts': '30f6eb108281385a98649215f9406b81bacc99cce85c112ac8582d5de2e44a23',
  'app/api/admin/concerns/route.ts': '668f696b3acc07f886fb4a529d1320f126cfaec07bc68b9a8feb1ab29bd8f2b8',
  'app/api/admin/consent/route.ts': '2b794449aecdd21865684e890b9add1e5b196c46a31f81b5ac842aabb2fb33e2',
  'app/api/admin/dashboard/route.ts': '2b794449aecdd21865684e890b9add1e5b196c46a31f81b5ac842aabb2fb33e2',
  'app/api/admin/doctors/[authId]/credentials/route.ts': '6ae2422aac5148668ef3db62c05e6f14903aea6523e9d6b956289f4288fb8b69',
  'app/api/admin/doctors/route.ts': '8a4dde713a88fa816fb6e13a79b545da6ce96b23c060b3bb66973592bb1f86fd',
  'app/api/admin/membership/route.ts': 'fd135765f187852cfb04b81661e69b6b49fd14b433a9d7209779593d5fd63a1b',
  'app/api/admin/messaging/conversations/[conversationId]/hold/route.ts': 'd7733f9989bff43c1188db02c8c83592be328520a051378c2dc8798c0b40a976',
  'app/api/admin/messaging/conversations/route.ts': '5596709f083a60e1279856ba2d9695775e5fd31ab3cf63736b5862b306dcdb66',
  'app/api/admin/route.ts': 'c15c73afb1b44fdd46d96a2c0380f268d15ebd56119c97c6982343dec84e1782',
  'app/api/admin/users/route.ts': 'fea7e42b9b8642cfb4b9500ad1f090f064c848590309d417975caea9a14bea4f',
  'app/api/appointments/[appointmentId]/complete/route.ts': '77e224e1b5f3493115b46d76b98bef327b42ca92e60fd8af73d07cbd6c76ea09',
  'app/api/appointments/[appointmentId]/concerns/route.ts': 'c9a3f2e09aed9310dabc01f3edc94b97be29e10c054c2f0a9e8140608301e19d',
  'app/api/appointments/[appointmentId]/feedback/route.ts': '8ec60f817fd7b204124ce1a7d6f2e989fe914f84a29a5c1e0603a768e2b6368a',
  'app/api/appointments/[appointmentId]/messages/read/route.ts': '050e1a07fbb2ff49b5deafedcafcb582e85e72ecbcf60e664afa535624435d53',
  'app/api/appointments/[appointmentId]/messages/route.ts': '8d2ccc0566a3517726c8081da359b65434ce946d260b49092b2bcc2d949751b7',
  'app/api/appointments/[appointmentId]/messages/stream/route.ts': 'daa2995b586a69b734f9acc0c48feb43aa1fc892a1c0becfee9a00399339846a',
  'app/api/auth/consent/route.ts': '17fed91b72ec50594b3e3541f86db58266d0e2d43dc7302f16e800dd595b9de6',
  'app/api/auth/google/url/route.ts': '917968f13f9a262a5d28a402a71df86e2cdcd4ed957f6b4a6e990524b0ede8b0',
  'app/api/auth/login/resend/route.ts': '4c077d838874ea152c83e59927aef14248b38c4524efbbd7151acefbfd4242cd',
  'app/api/auth/login/route.ts': 'db366d0fe82e01cd8c5297f3df4f24b34abf2c65cb411b6a220e182485b62342',
  'app/api/auth/logout/route.ts': '216837e425b512815376dcb19feba0a89d2c0c90443e0d4fcdd7ad27b534591d',
  'app/api/auth/me/password/route.ts': 'f9cb254895ae80c2adb4afd469f5617b69f57287b38b0b5fec0daf217b200ec5',
  'app/api/auth/me/profile-picture/route.ts': '48ae52ddbff896023428b1390ebb91e63888b4cb6b50bdd1a319ab35c2350dc3',
  'app/api/auth/me/route.ts': '3f303a4e7f857648a0b4cd256461ef61966b834322467f5b4ba92e20f2700b79',
  'app/api/auth/password/change/route.ts': '2de882b770dadb6da160b3c94bda77beb7cf3f62f57a69b7b4e4ffd4b1273849',
  'app/api/auth/password/forgot/route.ts': '9c3fd84e8dc8e0734377d798ccd0114891edaa582fa1a7559baeb8edbc3b8e22',
  'app/api/auth/password/reset/route.ts': 'fb5b5b6f29b0c5fde2d9aafd1a2046dcf6493c6f71e26c293a133e94b19f699e',
  'app/api/auth/refresh/route.ts': '7d4f047800a0872cb392973fa3cf3afbefa73def6e1b130a533f20c02233b5af',
  'app/api/auth/register/route.ts': '9b0a3f27fb3291b6e70cb831073931131face4043fd7712f810abaa4b6432d9c',
  'app/api/auth/session/route.ts': 'ee2fd8f7fa8a3619f614456e4f329a627f71eec26455bf6f121ffc17b56fae6d',
  'app/api/auth/sso/callback/route.ts': 'b0dc64e7c4dbebd93bb9b20c595c9e1c502e235ae288ca8e3cc15fe60bd5e382',
  'app/api/auth/verify-2fa/route.ts': 'b76abd03605ef45a88293226c61008dfe00100437715269ad067b7333708d588',
  'app/api/auth/verify/resend/route.ts': '689fc212070eedff2f5329ae22630276f72e521076dd23282a72c07275b992a5',
  'app/api/auth/verify/route.ts': '2561cedabe6e5db984263d7ab81a15238bcbe54e9b946e2d48050a6e19fe27a9',
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
  'app/api/doctor/onboarding/route.ts': '25a7cc2305d9f8ae4c98fee3aea3f7861431a916c88e0c136edd8bc3b8fa180c',
  'app/api/doctor/patients/[patientId]/opqrst/route.ts': 'a6c3e7e7a6c759e0a4aa4af80cc9f0a0c83307875807800568036c9488f7e30f',
  'app/api/doctor/patients/[patientId]/record/route.ts': 'd900897a1c4e6b5fbb4acd0894a20d74c75f692bb632e02a1e07df7a999b503f',
  'app/api/doctor/patients/[patientId]/snapshot/route.ts': 'd1b48a6cd90873d4b0f80937b53c574d353e07838aa74411377973f6e57f1463',
  'app/api/doctor/patients/route.ts': '70b63e78117acacfb4accb12c8c1db5e40793309887f06a8eac04d38947972d4',
  'app/api/doctor/payment-qr/[qrId]/file/route.ts': '1651f810e1d06e79178f87d2a3b26e9f1177708c050a32b1761ba72d5a58f49f',
  'app/api/doctor/payment-qr/[qrId]/route.ts': '6dd2b5f8d9b292c1bd9f0a2de8fa37898143e28f3747ae09d94d5b5ffcb1418c',
  'app/api/doctor/payment-qr/operations/[operationId]/route.ts': '1651f810e1d06e79178f87d2a3b26e9f1177708c050a32b1761ba72d5a58f49f',
  'app/api/doctor/payment-qr/route.ts': '3a2b96df5aedaefa86a316211de40cdd15d41a314b0ce462380cca9f93c512cb',
  'app/api/doctor/profile/onboarding/route.ts': '399bb97ec3b2d15c11d9d1b42ef4e927668ec457070814d121f9e91ee92a800f',
  'app/api/doctor/profile/picture/route.ts': '9dcbfb06ebbad4ebb7a909aae8393f615e27a48ad9a0e45f6c5df14bd0438e61',
  'app/api/doctor/profile/route.ts': '7f7791c81ec5b78556308118962f0c6c31e86edcf9fea1e51a93401d9bb53b85',
  'app/api/doctor/records/files/[assetId]/file/route.ts': '85de8ad4464a7776ff319f71eaa3a8540c4c471a1c0c61076263674ed3dd633c',
  'app/api/doctor/records/operations/[operationId]/route.ts': 'c8b8003bde8ed6c87373b7ffabab89db6fbe4673d79118d1b01fe25c607a4fd7',
  'app/api/doctor/route.ts': '8ae07d5803a150f8332ee8075a210778f7e2b3a25f64df8964c8ab167e477bd1',
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
  'app/api/patient/profile/onboarding/route.ts': 'bf6aedc45b5ca55970fd6a1bf54bf2c1c9bfb2776d5cf8ad67465affdc4403c4',
  'app/api/patient/profile/registration/route.ts': '63421110a0afff6de6e543b4eb14fa8ec189e89a1137a1752d95a47989466c36',
  'app/api/patient/profile/route.ts': 'b677da348574b0f59c1856d16a00e31475aa0acbe3227b0e01fc47b0c1859866',
  'app/api/patient/records/operations/[operationId]/route.ts': 'c8b8003bde8ed6c87373b7ffabab89db6fbe4673d79118d1b01fe25c607a4fd7',
  'app/api/patient/records/route.ts': '41f32e2993c23fead0a78700816755935ac496bc7dc0818b502941478705bdc0',
  'app/api/patient/route.ts': '52542d88224189b2dea83c7e1a291c03ba5933570e55c8387a889cf00fef1a15',
  'app/api/ph-address/route.ts': 'ad7774cfb49fe2391c59a7ece04fc917caf299de9ed601c01d693a317b86f009',
  'app/api/test-support/e2e/credentials/consume/route.ts': 'a45e7baf73b2466288558148ce6aa1d45c11063db7bce262d4df490511594ca2',
  'app/api/trace/departments/route.ts': '7ed118cc6f69b4358298c07f2409228b89c05a28717562fbaee52b8c24cd20f7',
  'app/integrations/v1/appointments/route.ts': 'abdbd0d72647c50059fcb1f1678286bb7636048492be93715e490a19a86b7175',
  'app/integrations/v1/doctors/route.ts': 'd11076efaba62e7ebc23ed11bc4f9718bb6ef6960c49bdf536447203306b71ac',
  'app/integrations/v1/medical-certificates/route.ts': '8c4da06509127994e10d02035a90b64727f3c470f5699bff1b963f3e394147f0',
  'app/integrations/v1/patient/appointments/route.ts': 'e3dd75935c66d90bc07d04d94bd393d387f97e89d80210a589ecd15a17efd6f9',
  'app/integrations/v1/patient/bootstrap/route.ts': 'b414996a9d2d6ce72aba99e3c0a68d3b2107e4c630561b12a372cefbfd799d27',
  'app/integrations/v1/patients/route.ts': 'd58b8aa4a31c090024f92bfda5eb74360e50877df97d84319eb0a46b816628bb',
  'app/integrations/v1/prescriptions/route.ts': '2c1bcd6627113ac217b81a002248ffe69e0ce82629a91c85840b1c4b057d9219',
  'app/internal/users/[user_id]/roles/route.ts': '1ec836806535d438ba3068da48ed42327adff1ff3ea13302a54afa30418fa935',
  'lib/admin-management.ts': 'c00eae44dc4bfbbf6f8d1ddc1c91f139ce06634169b8801300b263cf966b7da8',
  'lib/allergies.ts': '90c0767d3818cc6dea00d19dd374b35b40f08aae2421f38c88553c0d49e13ff1',
  'lib/appointment-action-state.ts': 'bb725cb2a1956750493e931e8c137adc222a4bb6e3684d25f9ce4cd3ba6249aa',
  'lib/appointment-lifecycle.ts': 'b4c5cec819a9e80d835bbcd6abe146730cf267115ee46dceeaa34ff7197fe49e',
  'lib/appointment-serializer.ts': '5118b6ff529b32fe59a7be0a5c9fb5ac9af7b9579898eee6519f26b9b8cb2c6c',
  'lib/auth-error-response.ts': 'e0aa15e80079cbf066cb4926636a7f322c2c8c8cb9a722ff1c4254ccba0547d9',
  'lib/auth-errors.ts': 'a81541a86b92d8d06daa8db996e0f914dbb9c4124accc2699189b28ab5519e92',
  'lib/auth-profile-format.ts': '7b747465ce29a41dabd9cfb06927e90a1eeca55c66d8f9fe1ec28510d0a6f27d',
  'lib/auth-profiles.ts': '4dc2dd0ab6631a7c28fe6d08976b3f3273342a171837f2fb8af3a20cf4cdfb14',
  'lib/auth.ts': 'd7e4b7b7202b8dcbeaf4ce44eb69afba2b45b12cb205e47e8988a2728fdb63e6',
  'lib/client-session.ts': '7920ad8b7bc03e620ed9276bb116946c66462af246ded56d59cd92093cdd4554',
  'lib/cn.ts': 'e05155c088aebc65066f00d1d3bcf556509d157e15c62c99ba391e58b28692e6',
  'lib/cookies.ts': 'ca53e11a9b83c462fecd2ee4eae8d2a4d41edccbde507f96af689645d9e9e359',
  'lib/date-block-matching.ts': '284b1f3d2d6bbd5c11029ad1374321365a958be35d175d8de1328e42b8111f3b',
  'lib/doctor-date-blocks.ts': '43dcc61c355369720e333f723c7a389c019d5af84cfebe7c386de893033f57a2',
  'lib/doctor-record-snapshot.ts': '2ba93c05d22b00b4e7738d97b10156156a7761c9076184642efd994fca66144e',
  'lib/document-records.ts': 'ff94579da0c31e404de591f0648b509129b519a1cd47a05c87a727d520c28e2a',
  'lib/e2e-test-support.ts': 'b88ec8a7e3f6f5e9c7ac42219c116a9fb9e722b3c6515fc80e5dee1f49fa09d9',
  'lib/eda/appointment-bff.ts': '2063f7a9084f64b202dfea8ecb7987af2763354462403c05f4d504e5e2bb450f',
  'lib/eda/appointment-compatibility.ts': 'b83b098f9735f0ecb502886b2b9add2b9c9fb4b328e650172808d57b16af5ebd',
  'lib/eda/appointment-extras-bff.ts': 'cc922d17ca497c7d948a7b46914d2b77bd03a3f7d843019b1c9a13afb7bd84ef',
  'lib/eda/appointment-paths.ts': '230ff97ab4a9ba2cbdae99c78eaa41cecbcddafd864a08818daf796d401c6a9f',
  'lib/eda/appointment-read-bff.ts': '3fe895e20eaf04ea7ef05620ec70ce5bed283633bbecfbfa82628bcb557438ac',
  'lib/eda/appointment-read-dto.ts': 'fe4a56fbd378dbdd6f78f251bc0a09cdc2d80e249b8e82880994631b9715d7a6',
  'lib/eda/candidate.ts': '94f79ef985d6ff3301f3c902871b912d77229039bcbcc8d8ea56c7625b649115',
  'lib/eda/completion-bff.ts': 'ce3c9a12dce7089ae765f411be29130dd90663579bd51c7bd96bd20355e91a94',
  'lib/eda/completion-consent-list.ts': '7dad713da1ae78a1d6efeaf2ea8722ef9ce4c8443db4e3201e61382185996175',
  'lib/eda/completion-dto.ts': 'a5b4371edd03475500238a48e0e2721f5956a530258a60d3cd342339e7f9ccfe',
  'lib/eda/completion-export.ts': '86253ac46aff7904b418b578799025eb6055e7cc3b5a6cac71518f1c49ac9fad',
  'lib/eda/completion-notifications.ts': '251db7084385a1d72f589a98768fef1cf3f6c40e87a3d3bd57dfbc3b1ac99386',
  'lib/eda/completion-paths.ts': 'c4707d7717bb7bc82ff65e68b24ac80efa58079d32673bcd1222f685869a101e',
  'lib/eda/completion-route-policy.ts': '8cfc1d8bbe3bbc94efea2aa3914ea6647ef2b8909f05ccbfb6756e5fef344e52',
  'lib/eda/messaging-bff.ts': 'e51fa6048540b49d74a5ac06a3f65d529747b0d25e136a810f22be76f0bed6cb',
  'lib/eda/messaging-dto.ts': '11eed1dd253393407c30c338bbbe5b0dafb65bf14656e8a86f7527c52a9f427c',
  'lib/eda/messaging-paths.ts': '320185fde0904df6ac25828bebe20dd3a2a126138eac68b0980d5c7988dcced5',
  'lib/eda/messaging-route-policy.ts': 'f8fe5c61d6c5f7105e0fe9241816258bc5a63fb27ef37708831e7cef332b5e94',
  'lib/eda/messaging.ts': '1ce8421f0dbd074d669eaf85d5ee119f2a98cddcfd62efb74e9b9c8b5ceb9cd9',
  'lib/eda/mode-policy.ts': 'be4efe2812dbfdb277ab216cd1e6bc80adc4aa17b71f6200e8447f0a127d304c',
  'lib/eda/patient-onboarding.ts': 'bf14670643dc52a6693e4bb8ea452b247b43834246196f28554d9686673e092d',
  'lib/eda/patient-record-notice.ts': '966b336c56669936b94c6470a6598802335f0509f562e2373142f841a97db35c',
  'lib/eda/patient-workflow.ts': '81de5bf45249c1d71da5f7df9fda58866fcbd3a998cc5ca50e4b01b277533f4b',
  'lib/eda/payment-bff.ts': '01f92b501ebc5b910590908b60453788a245863d12a68e82265ba0f28b8ca22d',
  'lib/eda/payment-dto.ts': 'ee9aa64efb28fefeaa17c51695e06347d7cddfb174fa09046de7de82e4ffb496',
  'lib/eda/payment.ts': 'f108996aaaaef9917b8ae6cc687110f73b3e72e3b7823b0625cff647718fa0d0',
  'lib/eda/portal-doctor-provision-bff.ts': '4adc2fcd071dff24d58c96a9b6ca1bd3bfa8481aa8c3fff80a8dbede665f4a64',
  'lib/eda/portal-integrations-bff.ts': 'ae04c7bf3ce977f231320e844714d2e222df1664192240c3def8059b478da138',
  'lib/eda/portal-integrations-paths.ts': '9834b51150d903c8a159aba811b80fee23af252118ad7a93e2833d8669bb391b',
  'lib/eda/portal-integrations-route-policy.ts': '06fc03af6b23eae65c85848b971a5c9c4b50b6040ce1d52de9f52d4fbaf1a8da',
  'lib/eda/profile-dto.ts': '60804fedd58c4a71563c314ae4836fe41826f77dcd42aa94734c9960690c8468',
  'lib/eda/profile-mutations.ts': '9d729b6b827ff6a28eb8329f1cbe2fa4f58d6a4224cf81b26efc1172a7843f66',
  'lib/eda/profile-paths.ts': '2c12095977c5250ebc9bd20248c1c481201c28e79b410f5a9ec8776bfb1a01d4',
  'lib/eda/profile-qr-bff.ts': '747fd3ba19c1a4f4a9f30a706d6680226bf11dc99419f03a91d586f4fafff422',
  'lib/eda/profile-qr-paths.ts': '7be7aa43b0faa6845459f386f2ed701eb72263734e586f74c76f6f1d067ff67c',
  'lib/eda/profile-qr-transport.ts': '7ebc4662fc1795cc8dbfa51e742daf2bcebc7f0fc33f0d5fd71e7c100c4f9ba5',
  'lib/eda/profile-qr-upload.ts': '5af7ab231a9d1561643825e7a243935a83c406e395b298fb77bcbbc79721d2b4',
  'lib/eda/profile-registration.ts': '07ca27c21521d8a57ea3937d1081688e5719d82be92ab678d2d5b0afccde69f3',
  'lib/eda/profile.ts': '23b71089cd6f9e91448f3dd19fa61d86c329f882559c2785f3823f34e2f8cfb0',
  'lib/eda/public-registration.ts': '7b0aea5e63b0c3a64cd4fb255722f112f4c3f078c753e8f399046067ecf000a5',
  'lib/eda/records-bff.ts': '7d1887174fc887ff11042f23b3081ab8c4ca7d6f43b0991104942d40b2f71ff9',
  'lib/eda/records-composition.ts': 'd6d1fbd8c967eabea562ed1288a3023478043c426be99bfacdddec9259005aee',
  'lib/eda/records-dto.ts': 'a3bb99ac73bd619682d4bb127bef7af8cea1f1c5fb3480761cfad9c36394d060',
  'lib/eda/records-pages.ts': 'f2388350181fda90fad0d33a3ad9876dc69d4ff082cb6845c7bc8295ecbe3f18',
  'lib/eda/records-paths.ts': '1d04d2410401ebf0a6479bee57cd4fc9c7772293b58a4a976b97d3536bbfe0e6',
  'lib/eda/records-upload.ts': '9d5b67bb5407ffe2a96fd36a27b724147ea57176586ee94796adc1a7af34cbac',
  'lib/eda/records.ts': '26da670d769ba6d5c77d52958d04bfe71e5123aac7c476a72b473e89db8d3204',
  'lib/eda/request-body.ts': '7a78782d69c435e689b110eee50541ed73795c6bfcdb2aaa43ca6da10c71b0d5',
  'lib/eda/stream-bff.ts': '2fa4d988f94763e0876d4b4995c843c155846c1a61dd96ad537fed6ed01e32c7',
  'lib/eda/stream-transport.ts': 'ada0197f643603eb27a9659728a2629b0301ea96e81477afa5b737730037fd5d',
  'lib/eda/transport.ts': '1d7c16240904a69eb16dbe2236f9b515a5fd4593a91d9457a4ec10c138f3bf84',
  'app/api/internal/vital/readiness/route.ts': 'b7ffb181f5babb03300373584259088eb10b1d57494b09f579d93aa5183a0877',
  'tests/eda-readiness.test.ts': 'a37c0db033d0143465be8faf2472406e4a4ed75cb86000c6947ee1591cb2c16a',
  'lib/eda/video-bff.ts': '81021e8f76361365a7ebb5432b1242fffc5012b14196020f701fe732ee1811bd',
  'lib/eda/video-cookie.ts': '9c6a2a2f6510515aa225707a74448290a1cb1cb453e76e43b15ac5d6ffdd0842',
  'lib/eda/video-dto.ts': '1ac02c25a9a08dcfe9fa83ec8e85dc04eb69b52b03fe8efb268545643c0171fe',
  'lib/eda/video-paths.ts': 'f2f77f9361e32380196ae336d818ca19572ba599f04095e89bef5e73873cf5ff',
  'lib/eda/video.ts': 'c5b730aacb865400771b9a14a8cad335965c66faac246ec17c69788710519244',
  'lib/ehr-biometric.ts': 'ba0188af749c9f22b46aefb9d6807d2497459f3f73f73d0dc99338226babfaf6',
  'lib/ehr-integration.ts': '42653855fc0680810d0e7db09338f615de7a51bb586a937b69bc9bc06b333231',
  'lib/env.ts': '0731baabb0d884e77bde3c9f00e3a15597c8f78bbf86db7a19343053a1b5be70',
  'lib/errors.ts': 'a763f1f8be88fda317b4f85103e3883874879d1528cbeb816b690560fbb70510',
  'lib/form-validation.ts': '7585cdcdbd7f4d9eca0017fdf65ed59768bf156d3a936be14dc95991918e91f4',
  'lib/gateway-actor.ts': '620521eeac45bd4b96ed0512b214bf46dc730d83aac4258a10fad6041c651cbe',
  'lib/gateway.ts': '3000bdd412d2edcc71a9594e8e35415f5f2d926232d0b138b7b829760dd3a305',
  'lib/integration-api.ts': '28c82016ae6464c923b682d988fc8275f84deb8445ed8cd98c37daed5838f679',
  'lib/internal-auth.ts': '246c4562bd5d4ddf35b2366f49c5124b01781d8ebd81e8b91f21bcc0fa1a73aa',
  'lib/jwt.ts': 'acb2d4cb6353e2468244997729abe9d838e6677023ce9cc0a0509cfe2bd394d7',
  'lib/meeting-links.ts': 'e39d6c6ab7f3072022ff2578dd6cc6a379f414720278c96d6c02efdcf6c4e672',
  'lib/opqrst.ts': 'b96dec300919159a06bfeea6c22c8420ae907c10153d703789591352234eb4bc',
  'lib/password-policy.ts': '49bbe4b4ee4515747b42d0791625efbb669fe8930d5d53ebf38bd97558242142',
  'lib/patient-appointment-projection.ts': '0142d9c5f9f610811e99b214f8e32a59ece08cc7d91dac0b12ba2a3ad2660627',
  'lib/patient-booking.ts': '05757183a811861c777eb4dc05a1c110cf251c6f09020333a7cdd313fd770f70',
  'lib/patient-file-open.ts': '80a5a0a0ef634598fbb1aff73055c3cede7b687ca70f646c0a7021a5d0209940',
  'lib/ph-address.ts': '62d896dcfc81323f9f03aade96b908103504c1a39bf8d7e245e4089c35f0b9dd',
  'lib/profile-operation.ts': '6c0191f1023ba0cddda195bcbae6d9738a2c40da68656e4fb78c5c701e868158',
  'lib/reschedule-usage.ts': '584ec7c08356947ba226d7104a479b4abdf8ac88c3ec104fdd929e02f369dc4b',
  'lib/route-access.ts': 'ef5e8cd9f54f117214c5adfa08a7ad03753eba957efd781e20f35ea2df738c96',
  'lib/schedule-format.ts': '7dd0decb52f27260ebd1b2d8cf1fd599213f4e831f16f30fd36786f21dde9320',
  'lib/server-auth.ts': 'e613c514c8b0309b10ab1deaf9211a0d211e831a49eef5044e341e83caa2e9af',
  'lib/server-logger.ts': '0049707338533fca27a8049054f89f0c345dd48d54c46ae06dede3dd975c4c82',
  'lib/server-rbac.ts': '9ae2feaab1a9ed2e4e8348f287a083bf89751f49fb406e55c60677d366423614',
  'lib/session-response.ts': '87792f33813bf642f3657b059596799b0a86127fff1c888e57d271a4d0778f53',
  'lib/sso-return.ts': '0b6cd46792948116fca7d14ea69a6af7b1a4981734f77b211e5ee27fb7fd83db',
  'lib/sso-session.ts': '3d59568747c6a36d8f0fa244a53090be47cea4f0b1c6b9bc1437cb1d623c17c6',
  'lib/trace-departments.ts': 'ab4987f6fd5395c6e4da12c2fc3d3c1230ed2c91bf07a2efa127e928a5869d99',
  'lib/useAuthStore.ts': 'df13c11221360a3eaf70baa3f40150c50813fde91ecd660723ed7e1a5d16b946',
  'tests/admin-management.test.ts': '35618c7f1c28586b85b6d58c90c4bf2ff0675b5dc269de7101129f9f4cbf7074',
  'tests/allergies.test.ts': '7f57fecb3c9f0a3a8d9389ababb33e9ef3b33d3e884b02bbcaf30cfc176038ac',
  'tests/appointment-error-safety.test.ts': 'f283d5b3e80b6f24c1e993065a70b0e9816f5989b74eb0bb40caf4e24f2bc2ef',
  'tests/appointment-lifecycle.test.ts': '3a009196eca70ed89f3a179bdb0ce8bb93e1e1f2aae869b4e8aceb15a87e1780',
  'tests/auth-policy.test.ts': 'f724bb2b9f2f3f7e8175e8eed66846ea130d719260b591920ca37de37f44f7c5',
  'tests/bff-auth.test.ts': '60f12d85cfb5797cf89ac2d7ef641005371b85d560db12d827ec02ec6bad215f',
  'tests/cookies.test.ts': '9567dde1197dbc60db88e3d1a5bf5b9d0ffbd6375d0037f6ac5b6705055797af',
  'tests/doctor-date-blocks.test.ts': '4991273d672bb454e2ff719137231b358fbd5a271d1d58d76f2444627abc61fd',
  'tests/doctor-record-snapshot.test.ts': '25eb2b06571fbd9469fdb75ce877b4f52cd592277f05f725fbb3b0c6f40f7f01',
  'tests/eda-appointment-compatibility.test.ts': '37f67a86ee946ec6b0d3bb3533d279707972cea1c2381aed5adac7b3b9d790b5',
  'tests/eda-appointment-reads.test.ts': '9f60a653501a2c5f6efa356ea78ebca48cccda08a834751a7ad10b44a5793d0c',
  'tests/eda-appointment.test.ts': 'd9645cfa0f47c71b1880682fe84808d70c8d7f1ab7f3861c8735f8c7559b2420',
  'tests/eda-completion-aggregates.test.ts': '0e2f2cf2f671e2bc53ab80a69e4b153952f9d86e973855ed49c687bfc0864958',
  'tests/eda-completion-qr.test.ts': 'ec892990b4dbc18f825aae18fc46105bfec6536d5dfe9ad7ffe5e66347169efa',
  'tests/eda-messaging-bff.test.ts': '23c87bc228c5439be3884c2e7d023adc423622c9339fce22924056fe68e80842',
  'tests/eda-payment.test.ts': '6fb525abdff6c50f89d0ef893e33900028f6a3015eca2d3461e48b65f8f1bff6',
  'tests/eda-portal-integrations.test.ts': 'e08c5851a8a2a76d64fc95b8d2cdeebabbef2455bef5b44aab8e0e4a75d50485',
  'tests/eda-portal-provision.test.ts': 'c8cb9b33af32d2dfecbfc4cb740513d57a224ffcf64639b3635f63593d9852c7',
  'tests/eda-profile-boundaries.test.ts': '42ee67c3b583e58452611f70fcc1c36361439ec58d12eb4b216687814ab804d0',
  'tests/eda-profile-registration.test.ts': '363586ec8db429bcbcb0a86bc42f074c3ecb259d61e1eae1f92dbed9998dc5d5',
  'tests/eda-profile.test.ts': '30591454d873e6bc16c81d8dfa88be48e7e9ec3c2c02875f8a16aa75a61e01a6',
  'tests/eda-public-registration.test.ts': '66c48ccd6e7d5a7e76aa3f2893777deab6f3ed58cc59663c3feffd5008d3b4a0',
  'tests/eda-records-pagination.test.ts': '18a990da29ef3ef05cb9c1cc7ae2f846bcd5bc20a827a3c51d8262411d4cd2db',
  'tests/eda-records.test.ts': '03103dea537461fd952b59126ff3c08867a78f1d28dd05eb6b6ffdbc6aaa6a91',
  'tests/eda-remaining-owners.test.ts': '7636d90da065ad7830294bc4c0494c34e0323f5dbda6a4730eb5eece418c4bd8',
  'tests/eda-sse.test.ts': '1fb489e045e2b0a4b57bd48071ee92b22a32a421107dd7042036aeedae69c2d2',
  'tests/eda-transport.test.ts': 'cb1655b61712663535af377df977fe72cadd5ca415b17d606313550bd82a12a9',
  'tests/eda-video-appointment.test.ts': 'f0fb5b22446153a5a0416b5c14c1ee46a4df2863716392aeee259d3eb5ab49da',
  'tests/eda-video-transport.test.ts': '2259404aca880daadfc6d48244276c95fb4a526c0653f977a0a463bf56748517',
  'tests/eda-video.test.ts': '1f8958f5b8bc183e5ca61018df3f3ea2cd0784d61011e36e845bdf85a660b729',
  'tests/eda-bff-ownership.test.ts': '3981a10d60aaccda56fdb205175d5d9d42b9fe1819edfe0ed8b5ae481502385b',
  'tests/ehr-biometric.test.ts': '9271eb1e12c930c38c68e06edfb4adc5d556355b13dee00972f8884277de2b80',
  'tests/health-records-route.test.ts': '16fc6314dac832a453d6192edbfe9daaeeca4522b3047b3313c15efeba42be0c',
  'tests/helpers/appointment-preparation.ts': '56323a7cdffaaf2a62703683f338d95c3e01ad248f279218869b34c44f1a78ca',
  'tests/integration-api.test.ts': '004b75e8f3217b0bb2a1c05c7b5ce8d2c4f3e81af35fd5b2f69287e2c3f6f64c',
  'tests/meeting-links.test.ts': '69a58396b78f126f7f03df6ee6a3e30e81f9c1cd7d3ccf7efbdb7884f018cdaf',
  'tests/messaging-ui-state.test.ts': '8abfb81758b4d3bfaa3a232de4006aef9f27f3d5c6b7a44a005e28062f1c74dc',
  'tests/opqrst.test.ts': '83f76b4829895d7c7123883075997f97758fd9a514c08bcc01ea8aefcebd0475',
  'tests/patient-appointment-projection.test.ts': 'eaa2686e5418d6f3c1f4415da20ad5ab93edd6435204aa1762bc273f41fd40ed',
  'tests/patient-booking.test.ts': '09e994ab12d9400d7cded0fe70d0f0406675b60bba4b40db0e35123ba0cfd187',
  'tests/patient-file-open.test.ts': 'd85ca83ffd7892b84e307ae5e805a258c8b31f56df93824053c9c6ec2b91c629',
  'tests/ph-address.test.ts': 'f8476ae492c7611f07b596a20a6ed9b3b9def79179ea236df29e3f170d3561da',
  'tests/playwright-journey-profile.test.ts': 'f153bc65c948643e75032890d4d908b1ad64e291fce4eb8ea38352c03047cdae',
  'tests/reschedule-usage.test.ts': '3eb634a1f1c17d1b94c692f48a3c3f8f95e323cc0b0d18a90d3c174ecd8909c8',
  'tests/retired-concerns.test.ts': 'ee7d029344e984083635dc0d08e757c79b847129d964560ad42b279603363638',
  'tests/session-navigation.test.ts': 'e6ac9c5cbf8d8e0ff44ee9e6488116d667cbbedbfc8a3b236f9d16cda0b5500d',
  'tests/session-response.test.ts': '92bd9fb8904f7347c3d289e3915147e60c723e268ec73f79a48ae4459db45943',
  'tests/sso-return.test.ts': 'b0bb2c334290b63f41c443eb8f099e79b563946f51dc0c442319507d3cfd90b2',
  'tests/sso-session.test.ts': '8020847f102990e7fb0c333b8c3799262631dd4cd6472176cc9fbf759fcde73d',
});

const families = {
  revisions: { owner:'Services Appointment',entry:'lib/eda/appointment-revisions-bff.ts',dispatch:'targetAppointmentRevision',
    files:['lib/eda/appointment-revisions-paths.ts','lib/eda/appointment-paths.ts'],tests:['eda-appointment-revisions.test.ts'],
    request:'Strict role-bound complaint correction, paged admin ratings, bounded calendar preview and atomic batch command with UUID idempotency key',
    response:'Versioned complaint/history, rating page or calendar review/save receipt',statuses:[200,400,403,409,502,503],deps:['Core Appointment','Auth profiles'],flags:['VITAL_EDA_ENABLED','VITAL_EDA_APPOINTMENT_ENABLED']},
  notifications: {owner:'Central Notification',entry:'lib/eda/notification-inbox-bff.ts',dispatch:'targetNotificationInbox',
    files:['lib/eda/notification-inbox.ts'],tests:['eda-appointment-revisions.test.ts'],request:'Recipient-scoped VITAL inbox pagination or same-origin mark-read UUID',
    response:'VITAL-only unread count, persistent read state, server-generated appointment destination',statuses:[200,400,403,404,502,503],deps:['Gateway Notification VITAL inbox'],flags:['VITAL_EDA_ENABLED','VITAL_EDA_APPOINTMENT_ENABLED']},
  acknowledgment: {owner:'Services Payment',entry:'lib/eda/acknowledgment-bff.ts',dispatch:'acknowledgmentBff',
    files:['lib/eda/transport.ts','lib/eda/mode-policy.ts','lib/eda/profile.ts','lib/eda/records-bff.ts'],tests:['eda-payment.test.ts','eda-records.test.ts'],
    request:'GET own-patient or authorized admin acknowledgment by appointment UUID; backend authorization rechecks identity',
    response:'immutable completion-bound payment snapshot or hash-verified PDF bytes; refund status separate',statuses:[200,409,403,503],
    deps:['Appointment billing authority','Integrations Payment acknowledgment snapshot'],flags:['VITAL_EDA_ENABLED','VITAL_EDA_PAYMENT_ENABLED']},
  appointment: { owner: 'Services Appointment', entry: 'lib/eda/appointment-bff.ts', dispatch: 'targetAppointment',
    policy: ['lib/eda/appointment-paths.ts', 'appointmentRoute'],
    files: ['lib/eda/appointment-compatibility.ts', 'lib/eda/appointment-read-bff.ts', 'lib/eda/appointment-read-dto.ts'],
    tests: ['eda-appointment.test.ts', 'eda-appointment-reads.test.ts', 'eda-appointment-compatibility.test.ts', 'reschedule-usage.test.ts'],
    request: 'browserAppointmentInput; Idempotency-Key UUID on mutations; same-origin mutations; server command preparation supplies revisions',
    response: 'collectAppointmentRead/decodeAppointmentResponse; legacy lists and command DTOs; processing is not completed',
    statuses: [200, 201, 202, 409], deps: ['Core Appointment', 'Auth profiles', 'EHR identity/case receipt for booking/approval/follow-up', 'Payment checkout', 'Video finalization', 'Records completion snapshot'], flags: ['VITAL_EDA_ENABLED', 'VITAL_EDA_APPOINTMENT_ENABLED'] },
  extras: { owner: 'Services Appointment', entry: 'lib/eda/appointment-extras-bff.ts', dispatch: 'targetAppointmentExtras',
    policy: ['lib/eda/appointment-paths.ts', 'appointmentRoute'], files: ['lib/opqrst.ts'], tests: ['eda-remaining-owners.test.ts', 'opqrst.test.ts'],
    request: 'feedback strict integer rating 1..5 without comments; current revision; opqrst UUID patient; typed intake cursors',
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
    files: ['lib/eda/admin-directory.ts', 'lib/admin-management.ts', 'lib/eda/profile-dto.ts', 'lib/eda/profile-mutations.ts', 'lib/eda/patient-onboarding.ts', 'lib/eda/patient-workflow.ts'],
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
  trace: { owner: 'TRACE clinical specialty directory via Gateway', entry: 'lib/trace-departments.ts', dispatch: 'getTraceDepartments', files: [], tests: ['eda-remaining-owners.test.ts'],
    request: 'resolved BFF session; Gateway bearer lookup explicitly requests category=specialty', response: 'success/data:{departments} with verified clinical UUID/name pairs; catalog failures retryable503', statuses: [200, 500, 503], deps: ['Gateway session and TRACE active specialty lookup'], flags: [] },
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
add('revisions', `
GET /api/appointments/[appointmentId]/chief-complaint
PATCH /api/doctor/appointments/[appointmentId]/chief-complaint
GET /api/admin/doctors/[authId]/ratings
POST /api/doctor/date-blocks/preview
POST /api/doctor/date-blocks/batch`);
add('notifications', `
GET /api/notifications
PATCH /api/notifications/[notificationId]/read`);
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
add('acknowledgment', `
GET /api/patient/appointments/[appointmentId]/acknowledgment
GET /api/patient/appointments/[appointmentId]/acknowledgment/file
GET /api/admin/appointments/[appointmentId]/acknowledgment
GET /api/admin/appointments/[appointmentId]/acknowledgment/file`);
add('records', `
GET,POST /api/doctor/signing-profile
GET /api/documents/prescription/[documentId]
GET /api/documents/prescription/[documentId]/file
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
GET /api/admin/users adminDirectory
GET /api/admin/patients adminDirectory
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
  const allowed = new Set(['lib/eda/appointment-revisions-paths.ts', 'lib/eda/appointment-paths.ts', 'lib/eda/completion-route-policy.ts',
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
      ...(['revisions', 'notifications', 'appointment', 'extras', 'completion', 'payment', 'records', 'recordsIntegration', 'video', 'messaging', 'stream', 'qr', 'portal', 'profile', 'registration', 'export'].includes(rule.family)
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
