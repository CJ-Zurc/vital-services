import type { Pool } from 'pg';
import { DomainError,requireScope,type Actor } from '../../contracts/actor.js';
import type { VideoAuthority,VideoAssociations } from './contracts.js';
export const meetAutomationRetired=()=>{throw new DomainError(410,'MEET_AUTOMATION_RETIRED','Refresh VITAL and paste a Google Meet link manually.');};
function fail(status:number,code:string):never{throw new DomainError(status,'VIDEO_'+code,'Meeting resource unavailable.');}
export function createVideoModule(pool:Pool,authority:VideoAuthority,associations:VideoAssociations){
  return {
    associations,
    async resource(actor:Actor,id:string){requireScope(actor,'video.resource.read',id);const context=await authority.appointment(actor,id);
      const row=context.videoResourceId?(await pool.query(`SELECT * FROM video_resources WHERE id=$1 AND "doctorId"=$2 AND "billingLineageId"=$3 AND "preparedWorkflowId" IS NULL`,[context.videoResourceId,context.doctorId,context.billingLineageId])).rows[0]
        :(await pool.query(`SELECT * FROM video_resources WHERE "appointmentId"=$1 AND "doctorId"=$2 AND "associationVersion"=$3 AND "preparedWorkflowId" IS NULL`,[id,context.doctorId,context.associationVersion])).rows[0];
      if(context.consultationType==='virtual'&&!row)fail(503,'RESOURCE_NOT_FINALIZED');return{appointmentId:id,resourceId:row?.id??null,version:row?.version??0,associationVersion:context.associationVersion,meetingProvider:row?.provider??null,meetingUrl:row?.meetingUrl??null,normalizedMeetingUrl:row?.normalizedMeetingUrl??null,meetingUrlHash:row?.meetingUrlHash??null,meetingValidationStatus:row?.validationStatus==='validated'?'valid':row?.validationStatus??null,meetingLinkGeneratedAt:row?.linkGeneratedAt?.toISOString()??null,meetingLinkSavedAt:row?.linkSavedAt?.toISOString()??null};
    },
    async tick(){await associations.recover();return{processed:true};},
  };
}
