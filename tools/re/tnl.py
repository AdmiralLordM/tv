import sys,collections
def parse(path):
    toks=open(path,'rb').read().decode('latin1').replace('\r','').split('\n')
    toks=[t.strip() for t in toks if t.strip()!='']
    i=0; n=int(toks[i]); i+=1; segs=[]
    for s in range(n):
        x0,y0,x1,y1,N=map(int,toks[i].split(',')); i+=1
        a0,a1,rot=map(int,toks[i].split(',')); i+=1
        rx0,ry0=map(int,toks[i].split(',')); i+=1
        b0,b1=map(int,toks[i].split(',')); i+=1
        rx1,ry1=map(int,toks[i].split(',')); i+=1
        hp=int(toks[i]); i+=1
        light=int(toks[i]); i+=1
        missing=int(toks[i]); i+=1
        obst=int(toks[i]); i+=1
        obtex=int(toks[i]); i+=1
        faces=[int(toks[i+k]) for k in range(N)]; i+=N
        lmode=int(toks[i]); lint=int(toks[i+1]); amb=int(toks[i+2]); i+=3
        segs.append(dict(x0=x0,y0=y0,x1=x1,y1=y1,N=N,a0=a0,a1=a1,rot=rot,rx0=rx0,ry0=ry0,b0=b0,b1=b1,rx1=rx1,ry1=ry1,hp=hp,light=light,missing=missing,obst=obst,obtex=obtex,faces=faces,lmode=lmode,lint=lint,amb=amb))
    return segs, toks[i:]
if __name__=='__main__':
    stats=collections.defaultdict(collections.Counter)
    for p in sys.argv[1:]:
        try: segs,rest=parse(p)
        except Exception as e: print('FAIL',p,e); continue
        if rest: print('LEFTOVER',p,rest[:5])
        for s in segs:
            for k in ('N','a0','a1','rot','missing','obst','light','lmode','hp'):
                stats[k][s[k]]+=1
    for k,v in stats.items(): print(k, dict(v.most_common(12)))
