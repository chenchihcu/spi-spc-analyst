import csv, statistics as S, math, random
from scipy import stats
import numpy as np
rows=list(csv.DictReader(open('/workspace/spc/audit3/testdata/TEST-第三輪-01_groups.csv',encoding='utf-8')))
boards=sorted(set(r['板號'] for r in rows))
def med(v):return float(np.median(v))
def robust(v):
    m=med(v);s=med([abs(x-m) for x in v])*1.4826
    if not s>1e-9: s=np.std(v,ddof=1) or 1e-9
    return m,s
def winsor(v):
    m,s=robust(v);return [min(m+3*s,max(m-3*s,x)) for x in v]
def detrend(v,P):
    n=len(v)
    if n<P+2:return v[:]
    out=[]
    for i in range(n):
        lo=max(0,min(i-P//2,n-P));tr=sum(v[lo:lo+P])/P;out.append(v[i]-tr)
    return out
def welch(a,b):
    r=stats.ttest_ind(a,b,equal_var=False);return r.statistic,r.pvalue
key='面積%'
bm=[np.mean([float(r[key]) for r in rows if r['板號']==b]) for b in boards]
w=winsor(bm);rs=detrend(w,4)
odd=[x for i,x in enumerate(rs) if i%2==0];even=[x for i,x in enumerate(rs) if i%2==1]
t,p=welch(odd,even);print('B procedure (winsor+detrend4, board means): diff',np.mean([x for i,x in enumerate(bm) if i%2==0])-np.mean([x for i,x in enumerate(bm) if i%2==1]),'t',t,'p',p)
t2,p2=welch([x for i,x in enumerate(bm) if i%2==0],[x for i,x in enumerate(bm) if i%2==1]);print('board means, no detrend: t',t2,'p',p2)
# pad-level group-adjusted (area has no group effect anyway)
gm={}
for r in rows: gm.setdefault(r['元件群組'],[]).append(float(r[key]))
gm={g:np.mean(v) for g,v in gm.items()}
bi={b:i for i,b in enumerate(boards)}
po=[float(r[key])-gm[r['元件群組']] for r in rows if bi[r['板號']]%2==0];pe=[float(r[key])-gm[r['元件群組']] for r in rows if bi[r['板號']]%2==1]
t3,p3=welch(po,pe);print('pad-level group-adjusted: diff',np.mean(po)-np.mean(pe),'t',t3,'p',p3)
# null calibration: iid pads N(100,2.5), 25 boards x12 pads, no board effect; B's procedure
aB=.05/3/4
rng=np.random.default_rng(1)
ps=[];ps_raw=[]
for s in range(20000):
    x=rng.normal(100,2.5,(25,12)).round(1).mean(1).tolist()
    r_=detrend(winsor(x),4);o=r_[0::2];e=r_[1::2]
    ps.append(welch(o,e)[1]); ps_raw.append(welch(x[0::2],x[1::2])[1])
ps=np.array(ps);ps_raw=np.array(ps_raw)
print('null P(p<0.05) detrend',(ps<.05).mean(),' raw',(ps_raw<.05).mean())
print('null P(p<aB=%.5f)'%aB,(ps<aB).mean(),' P(p<aB/5)',(ps<aB/5).mean(),' P(p<=0.0006)',(ps<=0.0006).mean())
print('per-dataset 3 metrics approx P(any p<aB)',1-(1-(ps<aB).mean())**3)
