import { Router } from 'express';
import type { Pool } from 'pg';
/** Historical export: native callbacks use the signed native-dispute router. */
export function createAppointmentAppealsRouter(_pool:Pool){
  const router=Router();
  router.use((_req,res)=>{res.status(410).json({success:false,code:'APPOINTMENT_LEGACY_CALLBACK_RETIRED'});});
  return router;
}
