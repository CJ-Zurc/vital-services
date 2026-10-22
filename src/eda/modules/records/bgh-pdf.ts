import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ArtifactError } from './upload-validation.js';
import { philippineDate, validatePrescriptionLines, type RecordsFontConfig, type PrescriptionPdf, type CertificatePdf } from './legacy-pdf.js';
export type SigningFields={templateVersion?:string;signatureBase64?:string;signatureHash?:string;s2License?:string;s2ValidFrom?:string;s2ValidUntil?:string;patientAge?:string;patientSex?:string;patientAddress?:string;doctorContact?:string;doctorAddress?:string;doctorPtr?:string;retrievalUrl?:string;contentHash?:string};
export type AcknowledgmentPdf={reference:string;patientName:string;doctorName:string;appointmentId:string;paymentReference:string;paymentMethod:string;amountCentavos:number;paidAt:string;completedAt:string;issuedAt:string;sandbox:boolean;service:string;templateVersion:string};
const GREEN='#165b38';
function begin(title:string,date:Date,fonts?:RecordsFontConfig){
 const regular=fonts?.regularPath??'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',bold=fonts?.boldPath??'/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
 const logo=resolve('assets/documents/bgh-logo.png');
 if(!existsSync(regular)||!existsSync(bold)||!existsSync(logo))throw new ArtifactError('DOCUMENT_BRANDING_UNAVAILABLE',true);
 const doc=new PDFDocument({size:'A4',margins:{top:160,bottom:100,left:48,right:48},bufferPages:true,compress:false,info:{CreationDate:date,ModDate:date,Producer:'BGH VITAL Capstone',Creator:'BGH VITAL'}});
 const chunks:Buffer[]=[];const result=new Promise<Buffer>((ok,fail)=>{doc.on('data',c=>chunks.push(Buffer.from(c)));doc.once('end',()=>ok(Buffer.concat(chunks)));doc.once('error',fail);});
 doc.registerFont('regular',regular).registerFont('bold',bold);
 const header=()=>{doc.image(logo,48,42,{fit:[90,48]});doc.fillColor(GREEN).font('bold').fontSize(17).text('BERNARDINO GENERAL HOSPITAL',150,48,{width:395});
 doc.font('regular').fontSize(10).text('VITAL Telemedicine | Capstone Demonstration',150,76,{width:395});doc.moveTo(48,108).lineTo(547,108).strokeColor(GREEN).stroke();
 doc.fillColor('#111827').font('bold').fontSize(18).text(title,48,124,{width:499});doc.moveDown(.6);};header();doc.on('pageAdded',header);return{doc,result};
}
function field(doc:PDFKit.PDFDocument,label:string,value:string){doc.font('bold').fontSize(10).fillColor('#111827').text(label+': ',{continued:true}).font('regular').text(value||'Not recorded');doc.moveDown(.25);}
function finish(doc:PDFKit.PDFDocument,reference:string,clinical:boolean){const pages=doc.bufferedPageRange();for(let i=0;i<pages.count;i++){
 doc.switchToPage(i);doc.page.margins.bottom=0;doc.save();doc.font('bold').fontSize(8).fillColor('#9b1c1c').text(clinical?'CAPSTONE DEMONSTRATION — NOT FOR DISPENSING':'CAPSTONE DEMONSTRATION - TEST DOCUMENT',48,775,{width:499,align:'center',lineBreak:false});
 doc.font('regular').fontSize(7).fillColor('#4b5563').text(`${reference} | Page ${i+1} of ${pages.count}`,48,791,{width:499,align:'center',lineBreak:false});doc.restore();}doc.end();}
function meta(doc:PDFKit.PDFDocument,args:PrescriptionPdf&SigningFields){field(doc,'Reference',args.accessCode);field(doc,'Patient',args.patientName);field(doc,'Age / Sex',`${args.patientAge??'Not recorded'} / ${args.patientSex??'Not recorded'}`);field(doc,'Address',args.patientAddress??'Not recorded');field(doc,'Issued',philippineDate(args.issuedAt,true));doc.moveDown(.5);}
function sign(doc:PDFKit.PDFDocument,args:PrescriptionPdf&SigningFields){
 if(!args.signatureBase64||!args.signatureHash||!args.doctorLicense)throw new ArtifactError('DOCUMENT_SIGNING_EVIDENCE_REQUIRED');
 if(doc.y>570)doc.addPage();doc.moveDown();const y=doc.y;doc.image(Buffer.from(args.signatureBase64,'base64'),340,y,{fit:[160,60]});doc.y=y+66;
 field(doc,'Prescriber',args.doctorName);field(doc,'PRC License',args.doctorLicense);
 if(args.s2License)field(doc,'PDEA S2',`${args.s2License} (${args.s2ValidFrom} to ${args.s2ValidUntil})`);
 if(args.doctorPtr)field(doc,'PTR',args.doctorPtr);if(args.doctorContact)field(doc,'Contact',args.doctorContact);if(args.doctorAddress)field(doc,'Practice address',args.doctorAddress);
}
export async function bghPrescription(args:PrescriptionPdf&SigningFields,fonts?:RecordsFontConfig){
 validatePrescriptionLines(args.lines);const{doc,result}=begin('PRESCRIPTION',args.issuedAt,fonts);
 try{meta(doc,args);doc.font('bold').fontSize(22).fillColor(GREEN).text('Rx');doc.moveDown(.3);
 for(const[index,raw]of args.lines.entries()){const line=raw as typeof raw&{isControlled:boolean;brandName?:string;strength?:string;dosageForm?:string};
  if(typeof line.isControlled!=='boolean')throw new ArtifactError('PRESCRIPTION_CONTROLLED_FLAG_REQUIRED');if(doc.y>620)doc.addPage();
  doc.font('bold').fontSize(12).fillColor('#111827').text(`${index+1}. ${line.medicineName}${line.brandName?' ('+line.brandName+')':''}`);
  doc.font('regular').fontSize(10).text([line.strength,line.dosageForm].filter(Boolean).join(' | '));
  if(line.isControlled)doc.font('bold').fillColor('#9b1c1c').text('CONTROLLED MEDICINE - DEMONSTRATION ONLY');
  doc.font('regular').fillColor('#111827').text(`Dose: ${line.dosageAmount} ${line.dosageUnit} | Frequency: ${line.frequency}`);
  doc.text(`Route: ${line.route||'Not recorded'} | Duration: ${line.duration||'As directed'} | Quantity: ${line.quantity||'Not recorded'}`);if(line.instructions)doc.text(`Directions: ${line.instructions}`);doc.moveDown(.7);
 }
 sign(doc,args);if(!args.retrievalUrl)throw new ArtifactError('PRESCRIPTION_QR_ORIGIN_REQUIRED');const url=new URL(args.retrievalUrl);
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw new ArtifactError('PRESCRIPTION_QR_ORIGIN_REQUIRED');
 if(doc.y>640)doc.addPage();const y=doc.y+8;doc.image(await QRCode.toBuffer(url.href,{type:'png',errorCorrectionLevel:'M',margin:4,width:240}),48,y,{width:90});
 doc.font('regular').fontSize(9).text('Scan to retrieve in VITAL. Authorized login required.\nVITAL reference only; no pharmacy verification or dispensing status.',148,y+12,{width:350});finish(doc,args.accessCode,true);return await result;
 }catch(error){doc.destroy();void result.catch(()=>{});throw error;}
}
export async function bghCertificate(args:CertificatePdf&SigningFields,fonts?:RecordsFontConfig){const{doc,result}=begin('MEDICAL CERTIFICATE',args.issuedAt,fonts);
 try{meta(doc,{...args,lines:[]});field(doc,'Purpose',args.purpose);field(doc,'Findings / diagnosis',args.diagnosis);if(args.consultationDate)field(doc,'Consultation date',philippineDate(args.consultationDate));
 if(args.restStartDate||args.restEndDate)field(doc,'Recommended rest',`${args.restStartDate?philippineDate(args.restStartDate):'Not recorded'} to ${args.restEndDate?philippineDate(args.restEndDate):'Not recorded'}`);
 if(args.recommendation)field(doc,'Recommendation',args.recommendation);if(args.remarks)field(doc,'Remarks',args.remarks);sign(doc,{...args,lines:[]});finish(doc,args.accessCode,true);return await result;
 }catch(error){doc.destroy();void result.catch(()=>{});throw error;}
}
export async function createAcknowledgmentPdfBuffer(args:AcknowledgmentPdf,fonts?:RecordsFontConfig){if(!Number.isSafeInteger(args.amountCentavos)||args.amountCentavos<=0)throw new ArtifactError('RECEIPT_AMOUNT_INVALID');
 const{doc,result}=begin('PAYMENT ACKNOWLEDGMENT',new Date(args.issuedAt),fonts);
 try{field(doc,'Acknowledgment',args.reference);field(doc,'Patient',args.patientName);field(doc,'Doctor',args.doctorName);field(doc,'Appointment',args.appointmentId);field(doc,'Service',args.service);field(doc,'Payment reference',args.paymentReference);field(doc,'Method',args.paymentMethod);field(doc,'Paid',philippineDate(new Date(args.paidAt),true));field(doc,'Consultation completed',philippineDate(new Date(args.completedAt),true));
 doc.moveDown().font('bold').fontSize(18).fillColor(GREEN).text(`TOTAL PAID: PHP ${(args.amountCentavos/100).toFixed(2)}`);doc.moveDown().font('regular').fontSize(10).fillColor('#111827').text('This payment acknowledgment does not replace a BIR-authorized invoice.');if(args.sandbox)doc.moveDown().font('bold').fillColor('#9b1c1c').text('TEST — NO ACTUAL PAYMENT');finish(doc,args.reference,false);return await result;
 }catch(error){doc.destroy();void result.catch(()=>{});throw error;}
}
