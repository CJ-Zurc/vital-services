import hmac
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer

capacity=threading.Lock()

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def reply(self,status,data):
        body=json.dumps(data).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def do_GET(self):
        if self.path!='/health':return self.reply(404,{'code':'NOT_FOUND'})
        self.reply(200,{'status':'alive'})
    def do_POST(self):
        secret=os.environ.get('VITAL_AI_RUNTIME_KEY','')
        if len(secret)<32 or not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+secret):return self.reply(403,{'code':'FORBIDDEN'})
        if self.path not in ['/analyze','/cluster']:return self.reply(404,{'code':'NOT_FOUND'})
        try:length=int(self.headers.get('Content-Length','0'))
        except ValueError:return self.reply(400,{'code':'INVALID_LENGTH'})
        if not 0<length<=4*1024*1024:return self.reply(413,{'code':'PAYLOAD_LIMIT'})
        if not capacity.acquire(blocking=False):return self.reply(429,{'code':'CAPACITY_BUSY'})
        try:
            self.connection.settimeout(10)
            payload=json.loads(self.rfile.read(length))
            result=subprocess.run([sys.executable,'-m','app.task'],input=json.dumps({'kind':self.path,'payload':payload}),text=True,capture_output=True,timeout=120)
            if result.returncode==75:return self.reply(429,{'code':'HEAVY_WORK_BUSY'})
            if result.returncode:return self.reply(503,{'code':'MODEL_UNAVAILABLE'})
            self.reply(200,json.loads(result.stdout))
        except Exception:self.reply(503,{'code':'RUNTIME_FAILED'})
        finally:capacity.release()

if __name__=='__main__':ThreadingHTTPServer(('0.0.0.0',8020),Handler).serve_forever()
