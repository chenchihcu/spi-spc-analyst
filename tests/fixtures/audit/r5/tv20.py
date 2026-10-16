import csv,numpy as np
rows=list(csv.DictReader(open('audit3/testdata/TEST-第三輪-02_lone_extreme.csv',encoding='utf-8')))
def med(a): return float(np.median(a))
def robust(v):
    m=med(v); s=med([abs(x-m) for x in v])*1.4826
    if not s>1e-9: s=np.std(v,ddof=1) or 1e-9
    return m,s
def check(rows,label,drop=set()):
    boards=sorted(set(r['板號'] for r in rows))
    bm=[];bad=[]
    for b in boards:
        v=[float(r['體積%']) for r in rows if r['板號']==b and r['元件群組']=='U1 QFP' and (b,r['焊墊']) not in drop]
        bm.append(np.mean(v)); bad.append(sum(1 for x in v if x<70 or x>130))
    m,s=robust(bm); i=boards.index('B07'); z=(bm[i]-m)/s; d=bm[i]-m; ex=bad[i]-med(bad)
    hit=abs(z)>=3.5 and abs(d)>=0.08*60 and (abs(z)>=5.5 or ex>=3)
    print(label,'B07 mean %.4f med %.4f s %.4f z %.3f d %.3f ex %d hit=%s'%(bm[i],m,s,z,d,ex,hit))
    # robust z of pads in group
    vals=[float(r['體積%']) for r in rows if r['元件群組']=='U1 QFP']
    pm=med(vals); mad=med([abs(x-pm) for x in vals])
    for p in ['U1-2','U1-3']:
        x=[float(r['體積%']) for r in rows if r['板號']=='B07' and r['焊墊']==p][0]
        print('  pad',p,x,'robust z %.2f'%((x-pm)/(1.4826*mad)), 'median %.3f MAD %.3f'%(pm,mad))
check(rows,'orig')
two=[dict(r) for r in rows]
for r in two:
    if r['板號']=='B07' and r['焊墊']=='U1-3': r['體積%']='55.0'
check(two,'two')
check(two,'two minus U1-2',{('B07','U1-2')})
check(two,'two minus both',{('B07','U1-2'),('B07','U1-3')})
check(rows,'orig minus U1-2',{('B07','U1-2')})
