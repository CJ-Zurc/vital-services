from functools import lru_cache
from typing import Any
import csv
from app.config import get_settings
from app.context import assertion
from app.model_assets import asset_path, model_fingerprint_versions
from app.symptom_matcher import MiniLmSymptomMatcher

@lru_cache
def components():
    from medcat.cat import CAT
    with (get_settings().bodhi_source_dir / 'csv' / 'nodes_symptom.csv').open(encoding='utf-8-sig', newline='') as stream:
        catalog={r['root_snomed_id']:r['root_snomed_name'] for r in csv.DictReader(stream) if r['root_snomed_id'] and r['root_snomed_name']}
    return CAT.load_model_pack(str(asset_path('medcatPackPath'))),MiniLmSymptomMatcher(),catalog


def analyze(payload:dict[str,Any], candidates:bool=True, confirmed=None)->dict[str,Any]:
    cat,matcher,catalog=components()
    concepts=[];flags=[]
    primary=payload.get('primarySymptom') or {}
    selected=primary.get('id')
    if selected in catalog:
        concepts.append({'id':selected,'name':catalog[selected],'assertion':'present','field':'primarySymptom','method':'selected'})
    fields={'chiefComplaint':payload.get('chiefComplaint') or '',
        **{k:(payload.get('opqrst') or {}).get(k,'') for k in ['associatedSymptoms','additionalNotes','symptomQualityOther','aggravatingFactors','relievingFactors']}}
    if not selected: fields['primarySymptom']=primary.get('name','')
    for field,text in fields.items():
        if not isinstance(text,str) or not text.strip(): continue
        output=cat.get_entities(text)
        for entity in output.get('entities',{}).values():
            start=int(entity.get('start',0));end=int(entity.get('end',start))
            # Offsets provide the original span even when MedCAT omits source_value.
            phrase=text[start:end]
            if not phrase: continue
            found,ambiguous=matcher.match([phrase])
            if ambiguous: flags.append('UNMATCHED_OR_AMBIGUOUS')
            status=assertion(text,start,end)
            for match in found:
                concepts.append({'id':match.root_snomed_id,'name':match.root_name,'assertion':status,'field':field,'method':'nlp','similarity':round(match.similarity,6)})
    if confirmed is not None:
        concepts=confirmed
    unique={ (c['id'],c['assertion'],c['field']):c for c in concepts }
    return {'concepts':list(unique.values())[:50],'candidates':[],
        'flags':sorted(set(flags)), 'versions':{**model_fingerprint_versions(),'normalization':'symptom-normalization-v2','context':'assertion-v1','similarityThreshold':str(get_settings().ai_similarity_threshold),'similarityMargin':str(get_settings().ai_similarity_margin)}}
