import numpy as np
rng=np.random.default_rng(1)
def rules(z):
    n=len(z);hit=set()
    if np.any(np.abs(z)>3): hit.add(1)
    for i in range(n):
        if i>=8 and (np.all(z[i-8:i+1]>0) or np.all(z[i-8:i+1]<0)): hit.add(2)
        if i>=5:
            d=np.diff(z[i-5:i+1])
            if np.all(d>0) or np.all(d<0): hit.add(3)
        if i>=13:
            d=np.diff(z[i-13:i+1]); 
            if np.all(d[1:]*d[:-1]<0): hit.add(4)
        if i>=2:
            w=z[i-2:i+1]
            if (w>2).sum()>=2 or (w<-2).sum()>=2: hit.add(5)
        if i>=4:
            w=z[i-4:i+1]
            if (w>1).sum()>=4 or (w<-1).sum()>=4: hit.add(6)
        if i>=7 and np.all(np.abs(z[i-7:i+1])>1): hit.add(8)
    return hit
for nb in (25,50):
    N=20000;cnt=0;per={}
    for _ in range(N):
        x=rng.standard_normal(nb); s=np.mean(np.abs(np.diff(x)))/1.128; z=(x-x.mean())/s
        h=rules(z)
        if h-{1}: cnt+=1
        for r in h: per[r]=per.get(r,0)+1
    p=cnt/N
    print(nb,'P(any rule 2-8 excl 7)=%.3f'%p,'5 indep charts: %.3f'%(1-(1-p)**5),{k:round(v/N,3) for k,v in sorted(per.items())})
