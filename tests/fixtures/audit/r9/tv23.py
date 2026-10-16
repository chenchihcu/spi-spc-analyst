import csv, numpy as np, math
from decimal import Decimal, ROUND_HALF_UP
rows=list(csv.DictReader(open('/workspace/spc/audit8/TEST-第八輪-01_PHME_NG.csv',encoding='utf-8-sig')))
def r1(x): return float(Decimal(repr(x)).quantize(Decimal('0.1'),ROUND_HALF_UP))
D=[]
for r in rows:
    g=''.join(ch for ch in r['ComponentID'] if ch.isalpha())
    D.append(dict(board=r['PanelID']+'-'+r['FigureID'],g=g,pad=r['ComponentID']+'-'+r['PadID'],h=float(r['Height(um)']),res=r['Result'].strip(),v=float(r['Volume(%)'])))
print('groups',{g:sum(1 for d in D if d['g']==g) for g in set(d['g'] for d in D)})
print('codes',{c:sum(1 for d in D if d['res']==c) for c in set(d['res'] for d in D)})
def run(step):
    for d in D:
        t=100 if (step and d['g']=='C') else 120
        d['hp']=r1(d['h']/t*100)
    ok=[d for d in D if d['res'].lower()=='ok']
    lo=min(d['hp'] for d in ok); hi=max(d['hp'] for d in ok)
    hlo=min(d['h'] for d in ok); hhi=max(d['h'] for d in ok)
    C=[d for d in D if d['g']=='C']; okC=[d for d in ok if d['g']=='C']
    v=np.array([d['hp'] for d in C]); mu=v.mean(); sl=v.std(ddof=1)
    ss=0;df=0
    for b in sorted(set(d['board'] for d in C)):
        x=np.array([d['hp'] for d in C if d['board']==b])
        if len(x)>1: ss+=((x-x.mean())**2).sum(); df+=len(x)-1
    sw=math.sqrt(ss/df)
    cpk=min(hi-mu,mu-lo)/(3*sw); ppk=min(hi-mu,mu-lo)/(3*sl)
    out=sum(1 for x in v if x<lo or x>hi)
    # robust per pad position
    rc=[]
    for p in sorted(set(d['pad'] for d in C)):
        x=np.array([d['hp'] for d in C if d['pad']==p])
        if len(x)>=5:
            med=np.median(x); mad=np.median(abs(x-med))
            rc.append(min(hi-med,med-lo)/(3*1.4826*mad) if mad>0 else float('nan'))
    print(f"step={step} okC={len(okC)} nOK={len(ok)} win hpct {lo}-{hi} height {hlo}-{hhi}  C mean {mu:.4f} Cpk {cpk:.4f} Ppk {ppk:.4f} out {out}/{len(v)} robust med {np.nanmedian(rc):.4f} pads {len(rc)} n/board {len(C)/len(set(d['board'] for d in C))}")
    # wrong behaviour: window from step-off with step-on data
    return lo,hi
lo0,hi0=run(False)
run(True)
# buggy: data at step on, window off
C=[d for d in D if d['g']=='C']
v=np.array([d['hp'] for d in C]); mu=v.mean(); sl=v.std(ddof=1)
ss=0;df=0
for b in set(d['board'] for d in C):
    x=np.array([d['hp'] for d in C if d['board']==b]); ss+=((x-x.mean())**2).sum(); df+=len(x)-1
sw=math.sqrt(ss/df)
print('buggy Cpk',min(hi0-mu,mu-lo0)/(3*sw),'Ppk',min(hi0-mu,mu-lo0)/(3*sl),'out',sum(1 for x in v if x<lo0 or x>hi0))
rc=[]
for p in sorted(set(d['pad'] for d in C)):
    x=np.array([d['hp'] for d in C if d['pad']==p]); med=np.median(x); mad=np.median(abs(x-med)); rc.append(min(hi0-med,med-lo0)/(3*1.4826*mad))
print('buggy robust med',np.median(rc))
