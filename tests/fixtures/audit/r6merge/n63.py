import csv, numpy as np
rows=list(csv.DictReader(open('/workspace/spc/audit3/testdata/TEST-第三輪-01_groups.csv',encoding='utf-8')))
v=np.array([float(r['體積%']) for r in rows]);b=np.array([r['板號'] for r in rows]);g=np.array([r['元件群組'] for r in rows])
N=len(v);B=sorted(set(b));k=len(B)
SST=((v-v.mean())**2).sum();SSW=sum(((v[b==x]-v[b==x].mean())**2).sum() for x in B);SSB=SST-SSW
sw=np.sqrt(SSW/(N-k));so=np.sqrt(SST/(N-1))
print('N',N,'k',k,'sw',sw,'so',so,'SSB/SST',SSB/SST,'thresh (k-1)/(N-1)',(k-1)/(N-1))
mu=v.mean();print('Cpk',min(130-mu,mu-70)/(3*sw),'Ppk',min(130-mu,mu-70)/(3*so))
# share of within-cell SS due to group differences
SSG=sum(((v[(b==x)&(g==y)]-v[(b==x)&(g==y)].mean())**2).sum() for x in B for y in set(g))
print('SSW',SSW,'SS within board x group',SSG,'fraction of within-board SS from group differences',1-SSG/SSW)
for y in sorted(set(g)):
  m=g==y;vv=v[m];bb=b[m];SST=((vv-vv.mean())**2).sum();SSW=sum(((vv[bb==x]-vv[bb==x].mean())**2).sum() for x in B);n=len(vv)
  print(y,'sw',np.sqrt(SSW/(n-k)),'so',np.sqrt(SST/(n-1)))
