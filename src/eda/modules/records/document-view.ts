/** Signature bytes belong only to the encrypted issuance source and rendered PDF. */
export function publicDocument(data:Record<string,unknown>){
 const {signatureBase64:_signature,...safe}=data;
 return safe;
}
