# Synthetic test data for audit3 (round 3). Not real production data.
import random, csv
random.seed(20261016)
GROUPS = {  # group label -> (pad ids, volume mean, sd)
    'U1 QFP':   (['U1-1','U1-2','U1-3','U1-4'], 100.0, 2.5),
    'U2 BGA':   (['U2-A1','U2-A2','U2-A3','U2-A4'], 88.0, 2.5),
    'C 0402':   (['C1-1','C1-2','C1-3','C1-4'], 106.0, 2.5),
}
def rows(extra=None):
    out=[]
    for b in range(1,26):
        bo = random.gauss(0,0.8)  # small board effect
        for g,(pads,mu,sd) in GROUPS.items():
            for p in pads:
                vol = round(random.gauss(mu+bo, sd),1)
                if extra and extra.get((b,p)) is not None: vol = extra[(b,p)]
                h = round(random.gauss(120,3),1)
                a = round(random.gauss(100,2.5),1)
                ox = round(random.gauss(0,4),1); oy = round(random.gauss(0,4),1)
                out.append([f'B{b:02d}',p,g,vol,h,a,ox,oy])
    return out
HDR=['板號','焊墊','元件群組','體積%','高度µm','面積%','X偏移µm','Y偏移µm']
def write(name, data):
    with open(name,'w',encoding='utf-8',newline='') as f:
        w=csv.writer(f); w.writerow(HDR); w.writerows(data)
    print(name, len(data))
base = rows()
write('TEST-第三輪-01_groups.csv', base)            # D-40: 元件群組 column, 3 groups, means 100 / 88 / 106
lone = [list(r) for r in base]
for r in lone:
    if r[0]=='B07' and r[1]=='U1-2': r[3]=55.0      # lone extreme pad, far below LSL 70
write('TEST-第三輪-02_lone_extreme.csv', lone)
