import json,sys
f=sys.argv[1]
for i,l in enumerate(open(f)):
    r=json.loads(l)
    if 'line' not in r: continue
    try: m=json.loads(r['line'])
    except Exception: print(i,r['dir'],'RAW',r['line'][:200]); continue
    meth=m.get('method'); p=m.get('params',{}) or {}
    s=''
    if meth=='session/update':
        u=p.get('update',{}); k=u.get('sessionUpdate')
        meta=json.dumps(u.get('_meta',{}))[:250]
        s=f"{k} tc={u.get('toolCallId','')} st={u.get('status','')} title={str(u.get('title',''))[:60]!r} kind={u.get('kind','')}"
        if k in('agent_message_chunk','agent_thought_chunk','user_message_chunk'):
            s+=' txt='+repr((u.get('content') or {}).get('text','')[:100])
        s+=' meta='+meta+' sid='+p.get('sessionId','')[:12]
    elif meth: s=json.dumps(p)[:300]
    else: s='RESULT/ERR '+json.dumps(m.get('result',m.get('error')))[:300]
    print(i,r['ts'],r['dir'],m.get('id',''),meth or '',s)
