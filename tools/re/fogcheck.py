import sys,struct,math
def pal(f):
    d=open(f,'rb').read(); return [tuple(d[i*3:i*3+3]) for i in range(256)]
def near(c,P,lo,hi):
    best=9999999;bi=0
    for i in range(lo,hi+1):
        p=P[i]; dd=abs(c[0]-p[0])*30+abs(c[1]-p[1])*59+abs(c[2]-p[2])*11
        if dd<best: best=dd;bi=i
    return bi
def f32(x): return struct.unpack('<f',struct.pack('<f',x))[0]
def gen(P,target,div,limit,hi):
    T=bytearray(4096)
    tc=P[target]
    for c in range(256):
        T[c]=c
        cur=[float(v) for v in P[c]]
        st=[f32((tc[i]-P[c][i])/div) for i in range(3)]
        for k in range(1,16):
            cur=[f32(cur[i]+st[i]) for i in range(3)]
            T[k*256+c]= near([math.trunc(v) for v in cur],P,0,hi) if c<limit else c
    return T
name=sys.argv[1]; L=[l.strip() for l in open('levels/'+name+'.lvl',encoding='latin1')]
vga=pal('art/'+L[4]); skyp=L[11]
import os
P=vga[:240]+([pal('art/'+skyp)[i-48] for i in range(240,256)] if os.path.exists('art/'+skyp) and os.path.getsize('art/'+skyp)>=768 else vga[240:])
fogidx=int(L[21]); print('fogidx',fogidx, 'sky',skyp)
f=open('fog/'+L[15],'rb').read()
for PP,lab in ((P,'withsky'),(vga,'vga')):
    T=gen(PP,fogidx,15.0,256,255)
    print(lab,'fog mismatches',sum(1 for i in range(4096) if T[i]!=f[i]))
l=open('fog/'+L[16],'rb').read()
for PP,lab in ((P,'withsky'),(vga,'vga')):
    T=gen(PP,0,float(sys.argv[2]),0x60,0xef)
    print(lab,'lte mismatches',sum(1 for i in range(4096) if T[i]!=l[i]))
