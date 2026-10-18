import pg from "pg";

// Called only by dedicated EDA processes (and isolated tests), never Web or the
// legacy backend. PostgreSQL timestamp columns discard offsets on Date inputs.
export function configureUtcDateParameters(){pg.defaults.parseInputDatesAsUTC=true;}

// Pool-local parsing preserves the development schema's UTC timestamp convention
// without changing the legacy runtime's connection or process timezone.
export const utcPgTypes:pg.CustomTypesConfig={
  getTypeParser(oid,format){
    if(format==="binary")return pg.types.getTypeParser(oid,"binary");
    if(oid===1114)return(value:string)=>new Date(value.replace(" ","T")+"Z");
    if(oid===1082)return(value:string)=>new Date(value+"T00:00:00Z");
    return pg.types.getTypeParser(oid,"text");
  },
};
