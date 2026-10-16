import numpy as np, pandas as pd
from scipy import stats
# TV-16
x=np.array([100.5,99.5,103.0,99.5,102.5]); m=5;p=1
s2=x.var(ddof=1); T2=(x-x.mean())**2/s2
print('TV16 s2',s2,'T2',T2)
a=0.0027
ucl1=(m-1)**2/m*stats.beta.ppf(1-a,p/2,(m-p-1)/2)
ucl2=p*(m+1)*(m-1)/(m*(m-p))*stats.f.ppf(1-a,p,m-p)
print('PhaseI',ucl1,'PhaseII',ucl2,'max',(m-1)**2/m)
# with m>=11 gate check: m=5 is below gate so UCL never displayed
def cap(v,l,u,cells):
    pass
def analyze(path,lsl,usl,grpcol,boardcol,valcol):
    d=pd.read_csv(path)
    out={}
    v=d[valcol]
    print(path,'n',len(v),'mean',v.mean(),'s',v.std(ddof=1))
    def pooled(df,keys):
        ss=0;dfree=0
        for k,g in df.groupby(keys):
            ss+=((g[valcol]-g[valcol].mean())**2).sum(); dfree+=len(g)-1
        return np.sqrt(ss/dfree)
    print(' sw board x grp',pooled(d,[boardcol,grpcol]),' board only',pooled(d,[boardcol]))
    ppm=0
    for gname,g in d.groupby(grpcol):
        sw=pooled(g,[boardcol]); so=g[valcol].std(ddof=1); mu=g[valcol].mean(); n=len(g); nb=g[boardcol].nunique()
        cp=(usl-lsl)/6/sw; cpk=min(usl-mu,mu-lsl)/3/sw; pp=(usl-lsl)/6/so; ppk=min(usl-mu,mu-lsl)/3/so
        se=1.96*np.sqrt(1/(9*nb)+cpk**2/(2*(nb-1)))
        pr=(stats.norm.cdf((lsl-mu)/so)+stats.norm.sf((usl-mu)/so))*1e6
        oos=((g[valcol]<lsl)|(g[valcol]>usl)).sum()/n*1e6
        med=g[valcol].median(); mad=np.median(abs(g[valcol]-med)); 
        print(f'  {gname} n={n} mu={mu:.7f} sw={sw:.7f} so={so:.7f} Cp={cp:.7f} Cpk={cpk:.7f} Pp={pp:.7f} Ppk={ppk:.7f} CI=[{cpk-se:.7f},{cpk+se:.7f}] predPPM={pr:.7f} oosPPM={oos:.1f} med={med} mad={mad}')
        ppm+=pr*n
        z=(g[valcol]-med)/(1.4826*mad)
        big=g[(abs(z)>=5)|(g[valcol]<lsl)|(g[valcol]>usl)]
        for i,r in big.iterrows(): print('    cand',r[boardcol],r.iloc[1],r[valcol],round(((r[valcol]-med)/(1.4826*mad)),3))
    print(' weighted pred PPM',ppm/len(d))
analyze('audit1/testdata/synthetic_test01.csv',70,130,'元件群組','板號','體積%')
analyze('audit3/testdata/TEST-第三輪-01_groups.csv',70,130,'元件群組','板號','體積%')
analyze('audit3/testdata/TEST-第三輪-02_lone_extreme.csv',70,130,'元件群組','板號','體積%')
