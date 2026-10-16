import math
def Phi(z): return 0.5*math.erfc(-z/math.sqrt(2))
def psf(k,lam): # P(X>=k)
  return 1-sum(math.exp(-lam)*lam**i/math.factorial(i) for i in range(k))
n=725; cells=20
for thr,lab in [(0.01,'v1.5 每格 0.01'),(0.01/cells,'v1.6 每格 0.0005')]:
  print(lab)
  for cpk in [1.33,1.40,1.45,1.50,1.60,1.67,1.70,1.80]:
    lam=n*2*Phi(-3*cpk)
    k=1
    while psf(k,lam)>=thr: k+=1
    pc=psf(k,lam); ds=1-(1-pc)**cells
    print(f"  Cpk {cpk:.2f} λ={lam:.5f} 需{k}筆 每格{pc*100:.3f}% 20格{ds*100:.2f}%")
