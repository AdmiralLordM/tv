import sys
def pal(f):
    d=open(f,'rb').read(); return [tuple(d[i*3:i*3+3]) for i in range(256)]
def near(c,P,lo,hi):
    best=9999999;bi=0
    for i in range(lo,min(hi,255)+1):
        p=P[i]; dd=abs(c[0]-p[0])*30+abs(c[1]-p[1])*59+abs(c[2]-p[2])*11
        if dd<best: best=dd;bi=i
    return bi
def avg(a,b):
    if a==(0,0,0): return b
    if b==(0,0,0): return a
    return tuple((x+y)//2 for x,y in zip(a,b))
vga=pal('art/vga.act')
full=open('fog/vga.mix','rb').read()
bad=0
import random
for _ in range(3000):
    a=random.randrange(256);b=random.randrange(256)
    if full[a*256+b]!=near(avg(vga[a],vga[b]),vga,0,256): bad+=1
print('vga.mix mismatches /3000:',bad)
m=open('fog/'+sys.argv[1]+'.mix','rb').read()
sky=pal('art/'+sys.argv[2])
for off in (0,192):
    P=vga[:240]+[sky[i-240+off] for i in range(240,256)]
    bad=0;n=0
    for a in range(0,240,7):
        for j in range(16):
            n+=1
            if m[a*16+j]!=near(avg(P[a],P[240+j]),P,0,256): bad+=1
    for a in range(240,256):
        for b in range(0,256,5):
            n+=1
            if m[3840+(a-240)*256+b]!=near(avg(P[a],P[b]),P,0,256): bad+=1
    print('skyoff',off,'bad',bad,'of',n)
