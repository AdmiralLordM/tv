import struct,glob,sys,collections
def size(d,o):
    t=struct.unpack_from('<I',d,o)[0]
    w=lambda k: struct.unpack_from('<i',d,o+4*k)[0]
    if t==0: return 4
    if t==1: return 0x10
    if t==2: return w(2)*12+12
    if t in (3,0x1f): return w(2)*4+12
    if t==4: return w(2)*8+12
    if t in (5,6,7,8,0xf,0x15,0x19,0x1a,0x1b,0x21): return w(1)*4+0x18
    if t==9: return 0x20
    if t in (0xa,0xb,0x12,0x14): return 8
    if t==0xc: return 0x1c
    if t==0xd: return 0x18
    if t in (0xe,0x11,0x18,0x1e): return w(1)*12+0x18
    if t==0x10: return 0x14
    if t==0x16: return w(1)*4+8
    if t==0x17: return 0xc
    if t==0x1d: return w(2)*0x20+0x1c
    if t==0x20: return 0x158
    return None
cnt=collections.Counter(); files=collections.defaultdict(set); bad=[]
hdr=collections.Counter()
for f in sorted(glob.glob(sys.argv[1]+'/*.bin')):
    d=open(f,'rb').read()
    t=struct.unpack_from('<I',d,0)[0]
    if t==0x20: cnt['FILE20']+=1; continue
    if t!=0x14: bad.append((f,'id',t)); continue
    sc,u1,bias,nv=struct.unpack_from('<iiii',d,4)
    hdr[(u1,)]+=1
    o=20+12*nv
    # engine: block list starts at param_1+5 ints?? check
    seq=[]
    while o+4<=len(d):
        t=struct.unpack_from('<I',d,o)[0]
        s=size(d,o)
        if s is None: bad.append((f.split('/')[-1],hex(o),hex(t))); break
        cnt[t]+=1; files[t].add(f.split('/')[-1]); seq.append(t)
        o+=s
    if o!=len(d): pass
    files['end'].add((f.split('/')[-1], len(d)-o))
for k,v in sorted(cnt.items(),key=lambda x:str(x[0])): print(k if isinstance(k,str) else hex(k),v, sorted(files[k])[:6] if not isinstance(k,str) else '')
print('bad',bad[:20], len(bad))
print('hdr u1',hdr)
print('trailing',collections.Counter(x[1] for x in files['end']))
