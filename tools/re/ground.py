import sys
def ground(H, x, z):
    tx=(x>>20)&255; tz=(z>>20)&255
    u=(x&0xfffff)>>4; v=(z&0xfffff)>>4   # 16-bit fractions
    h=lambda r,c: H[(r&255)*256+(c&255)]*0x8000
    h00=h(tz,tx); h01=h(tz,tx+1); h10=h(tz+1,tx); h11=h(tz+1,tx+1)
    if (tx&1)==(tz&1):
        if u<=v: return h00 + (v*(h10-h00)>>16) + (u*(h11-h10)>>16)
        return h00 + (u*(h01-h00)>>16) + (v*(h11-h01)>>16)
    if v < 0x10000-u:
        return h01 + ((0x10000-u)*(h00-h01)>>16) + (v*(h10-h00)>>16)
    return h01 + ((0x10000-u)*(h10-h11)>>16) + (v*(h11-h01)>>16)
H=open(sys.argv[1],'rb').read()
for a in sys.argv[2:]:
    x,z=map(int,a.split(','))
    g=ground(H,x,z)
    print(a, g, g/2**20, 'spawnY', (g+0x80000)/2**20)
