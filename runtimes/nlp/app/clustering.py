"""Versioned exploratory features; no graph pathways, complaints, or patient IDs."""
import hashlib
import json
from collections import Counter
from datetime import datetime, timezone

WEIGHTS={'symptoms':.70,'region':.10,'quality':.05,'onset':.05,'timing':.05,'severity':.05}

def distance(a,b):
    sa={x['id'] for x in a.get('symptoms',[])};sb={x['id'] for x in b.get('symptoms',[])}
    if not sa.intersection(sb): return 1.0
    score=.70*(1-len(sa&sb)/len(sa|sb));weight=.70
    for field,w in list(WEIGHTS.items())[1:]:
        x,y=a.get(field),b.get(field)
        if x is None or y is None or x=='UNKNOWN' or y=='UNKNOWN':continue
        if field=='severity': d=abs(float(x)-float(y))/10
        elif field=='quality':
            sx,sy=set(x),set(y)
            if not sx or not sy:continue
            d=1-len(sx&sy)/len(sx|sy)
        else:d=float(x!=y)
        score+=w*d;weight+=w
    return score/weight

def cluster(rows):
    import numpy as np
    from sklearn.cluster import DBSCAN
    fingerprint=hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    result={'featureVersion':'symptom-features-v1','inputHash':fingerprint,'boundedSnapshot':True,'windowDays':90,'capPerCohort':2000,'clusters':[],'cohorts':[]}
    for cohort in ['adult','pediatric']:
        data=[r for r in rows if r['features'].get('cohort')==cohort and r['features'].get('symptoms')][:2000]
        if len(data)<5:
            result['cohorts'].append({'cohort':cohort,'status':'insufficient_data','count':len(data),'noise':0});continue
        matrix=np.zeros((len(data),len(data)),dtype=np.float32)
        for i in range(len(data)):
            for j in range(i):matrix[i,j]=matrix[j,i]=distance(data[i]['features'],data[j]['features'])
        labels=DBSCAN(eps=.35,min_samples=5,metric='precomputed',n_jobs=1).fit_predict(matrix)
        result['cohorts'].append({'cohort':cohort,'status':'completed','count':len(data),'noise':int(sum(labels==-1))})
        for label in sorted(set(int(v) for v in labels)-{-1}):
            members=[row for row,l in zip(data,labels) if l==label]
            names=Counter(s['name'] for row in members for s in row['features']['symptoms'])
            result['clusters'].append({'id':f'{cohort}-{label}','count':len(members),'suggestedLabel':', '.join(n for n,_ in names.most_common(3)),
                'members':[r['id'] for r in members]})
    return result
