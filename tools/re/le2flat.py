"""Flatten a DOS/4GW LE executable into a raw image with internal fixups applied.

    python3 le2flat.py GAME.EXE game.bin   # VA = file offset + lowest object base (0x10000)
"""
import struct,sys,json
d=open(sys.argv[1],'rb').read()
import re
# The LE image sits behind the DOS/4GW stub; its offsets are relative to the inner MZ header.
le=d.index(b'LE\x00\x00\x00\x00\x00\x00')
mz=next(m.start() for m in re.finditer(rb'MZ',d) if m.start()+0x40<len(d) and m.start()+struct.unpack_from('<I',d,m.start()+0x3c)[0]==le)
H=lambda o:struct.unpack_from('<I',d,le+o)[0]
npages=H(0x14); psz=H(0x28); last=H(0x2c)
nobj=H(0x44); objtab=le+H(0x40); pmap=le+H(0x48)
fpt=le+H(0x68); frt=le+H(0x6c); dpo=H(0x80)
print('eip obj',H(0x18),'eip',hex(H(0x1c)),'esp',H(0x20),hex(H(0x24)),'datapages',hex(dpo))
objs=[]
for i in range(nobj):
  vs,base,fl,pi,pc,_=struct.unpack_from('<6I',d,objtab+i*24)
  objs.append((vs,base,fl,pi,pc)); print('obj',i+1,hex(vs),hex(base),hex(fl),pi,pc)
lo=min(o[1] for o in objs); hi=max(o[1]+o[0] for o in objs)
img=bytearray(hi-lo)
# page -> file
def pageoff(p): # p 1-based
  return mz+dpo+(p-1)*psz
nfix=0; skipped={}
for (vs,base,fl,pi,pc) in objs:
  for k in range(pc):
    p=pi+k
    sz=psz if p<npages else last
    raw=d[pageoff(p):pageoff(p)+sz]
    va=base+k*psz
    img[va-lo:va-lo+len(raw)]=raw
for (vs,base,fl,pi,pc) in objs:
  for k in range(pc):
    p=pi+k; pva=base+k*psz
    a,b=struct.unpack_from('<II',d,fpt+(p-1)*4)
    o=frt+a; e=frt+b
    while o<e:
      src=d[o]; flg=d[o+1]; o+=2
      cnt=None
      if src&0x20: cnt=d[o]; o+=1
      if cnt is None: soffs=[struct.unpack_from('<h',d,o)[0]]; o+=2
      tt=flg&3
      if tt!=0: raise Exception('non-internal fixup %x'%flg)
      if flg&0x40: tobj=struct.unpack_from('<H',d,o)[0]; o+=2
      else: tobj=d[o]; o+=1
      st=src&0xf
      toff=0
      if st!=2:
        if flg&0x10: toff=struct.unpack_from('<I',d,o)[0]; o+=4
        else: toff=struct.unpack_from('<H',d,o)[0]; o+=2
      if cnt is not None:
        soffs=[struct.unpack_from('<h',d,o+2*j)[0] for j in range(cnt)]; o+=2*cnt
      tgt=objs[tobj-1][1]+toff
      for so in soffs:
        sva=pva+so
        if sva-lo<0 or sva-lo+4>len(img): continue
        if st==7: struct.pack_into('<I',img,sva-lo,tgt); nfix+=1
        elif st==8: struct.pack_into('<i',img,sva-lo,tgt-(sva+4)); nfix+=1
        elif st==6: struct.pack_into('<I',img,sva-lo,tgt); nfix+=1
        else: skipped[st]=skipped.get(st,0)+1
print('fixups',nfix,'skipped',skipped,'lo',hex(lo),'hi',hex(hi))
open(sys.argv[2],'wb').write(img)
json.dump({'lo':lo,'objs':objs,'eip':objs[H(0x18)-1][1]+H(0x1c)},open(sys.argv[2]+'.json','w'))
