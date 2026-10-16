# Does a label-permutation test on 4-MA-detrended board means calibrate the odd/even contrast? (D-64 option ②)
import numpy as np
rng=np.random.default_rng(7)
n=25;P=4
lo=np.array([max(0,min(i-P//2,n-P)) for i in range(n)])
D=np.eye(n)
for i in range(n): D[i,lo[i]:lo[i]+P]-=1/P
def tstat(r,mask):
    a=r[...,mask];b=r[...,~mask]
    va=a.var(-1,ddof=1)/a.shape[-1];vb=b.var(-1,ddof=1)/b.shape[-1]
    return (a.mean(-1)-b.mean(-1))/np.sqrt(va+vb)
alt=np.arange(n)%2==0
NS=4000;NP=999
perms=np.array([rng.permutation(alt) for _ in range(NP)])
pv=[]
for s in range(NS):
    x=rng.normal(0,1,n); r=D@x
    t0=abs(tstat(r,alt))
    # permutation distribution
    a=np.where(perms,r,np.nan)
    tp=[]
    ts=np.array([abs(tstat(r,m)) for m in perms])
    pv.append((1+(ts>=t0).sum())/(NP+1))
pv=np.array(pv)
for a in [0.05,0.01,0.05/5/4]:
    print(f"alpha {a:.5f}: P(perm p<alpha)={ (pv<a).mean():.4f}  (n={NS})")
# theoretical: variance of alternating contrast vs random contrast on residuals
c_alt=np.where(alt,1/13,-1/12)
print("var alt contrast of residuals",c_alt@D@D.T@c_alt)
vs=[];
for m in perms[:500]:
    c=np.where(m,1/13,-1/12);vs.append(c@D@D.T@c)
print("mean var random contrast",np.mean(vs))
