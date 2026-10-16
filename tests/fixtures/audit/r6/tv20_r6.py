import csv,statistics as stt
P='/workspace/spc/audit3/testdata/TEST-第三輪-02_lone_extreme.csv'
rows=list(csv.DictReader(open(P,encoding='utf-8-sig')))
def med(v):return stt.median(v)
def robust(v):
    m=med(v);s=med([abs(x-m) for x in v])*1.4826
    return m,s
def scen(mod,remove=()):
    R=[dict(r) for r in rows]
    for r in R:
        if r['板號']=='B07' and r['焊墊'] in mod: r['體積%']='55.0'
    g=[r for r in R if r['元件群組']=='U1 QFP']
    vals=[float(r['體積%']) for r in g]
    m,mad=med(vals),med([abs(float(r['體積%'])-med(vals)) for r in g])
    zs={p:(55.0-m)/(1.4826*mad) for p in mod}
    boards=sorted(set(r['板號'] for r in g))
    bm=[]
    for b in boards:
        v=[float(r['體積%']) for r in g if r['板號']==b and not (b=='B07' and r['焊墊'] in remove)]
        bm.append(sum(v)/len(v))
    bm7=bm[boards.index('B07')]
    M,S=robust(bm)
    return dict(n=len(vals),median=m,MAD=mad,z_pad=zs,B07_mean=round(bm7,2),B07_z=round((bm7-M)/S,2),d=round(bm7-M,2),boards=len(boards))
print('① ',scen(['U1-2']))
print('①remove U1-2',scen(['U1-2'],['U1-2']))
print('③ ',scen(['U1-2','U1-3']))
print('③remove U1-2',scen(['U1-2','U1-3'],['U1-2']))
print('③remove both',scen(['U1-2','U1-3'],['U1-2','U1-3']))
# MAD=0 fixture
v=[120]*28+[121]*2;m=med(v);mad=med([abs(x-m) for x in v]);mean_ad=sum(abs(x-m) for x in v)/30
print('fixture5',m,mad,mean_ad*1.2533,max(mean_ad*1.2533,1/12**.5),1/max(mean_ad*1.2533,1/12**.5))
