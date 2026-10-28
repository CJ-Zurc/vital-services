import contextlib
import io
import json
import os
import sys
import uuid

def main():
    from redis import Redis
    request=json.load(sys.stdin)
    redis=Redis.from_url(os.environ['VITAL_AI_COORDINATION_URL'],socket_connect_timeout=3,socket_timeout=3)
    token=uuid.uuid4().hex;key='analytics:heavy-work:lease'
    # Child hard deadline is 120s; the shared lease outlives it. No model is loaded without capacity.
    if not redis.set(key,token,nx=True,ex=180):sys.exit(75)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            if request['kind']=='/analyze':
                from app.inference import analyze
                result=analyze(request['payload']['payload'],request['payload'].get('candidates',True),request['payload'].get('confirmedConcepts'))
            else:
                from app.clustering import cluster
                result=cluster(request['payload']['rows'])
        print(json.dumps(result))
    finally:
        redis.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) end return 0",1,key,token)

if __name__=='__main__':main()
