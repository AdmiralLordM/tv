import struct,sys,os
src,dst=sys.argv[1],sys.argv[2]
for pod in ['STARTUP.POD','CDROM.POD']:
    d=open(os.path.join(src,pod),'rb').read()
    n=struct.unpack_from('<I',d,0)[0]
    for i in range(n):
        o=84+i*40
        name=d[o:o+32].split(b'\0')[0].decode('latin1').replace('\\','/').lower()
        sz,pos=struct.unpack_from('<II',d,o+32)
        p=os.path.normpath(os.path.join(dst,name))
        if not p.startswith(dst): continue
        os.makedirs(os.path.dirname(p),exist_ok=True)
        open(p,'wb').write(d[pos:pos+sz])
