import sys
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables.sbixStrike import Strike
from fontTools.ttLib.tables.sbixGlyph import Glyph
src,dst=sys.argv[1:3]
t=TTFont(src)
sd=t['CBDT'].strikeData[0]
sb=newTable('sbix'); sb.version=1; sb.flags=1; sb.strikes={}
st=Strike(ppem=109,resolution=72)
for name,o in sd.items():
    m=o.metrics
    g=Glyph(glyphName=name,graphicType='png ',imageData=o.imageData,originOffsetX=m.BearingX,originOffsetY=m.BearingY-m.height)
    st.glyphs[name]=g
sb.strikes[109]=st
t['sbix']=sb
del t['CBDT']; del t['CBLC']
t.save(dst)
# add empty glyf
from fontTools.ttLib.tables._g_l_y_f import Glyph as GG
t=TTFont(dst)
order=t.getGlyphOrder()
glyf=newTable('glyf'); glyf.glyphs={}; glyf.glyphOrder=order
for n in order: glyf.glyphs[n]=GG()
t['glyf']=glyf; t['loca']=newTable('loca')
t['maxp'].tableVersion=0x00010000
for a in ['maxZones','maxTwilightPoints','maxStorage','maxFunctionDefs','maxInstructionDefs','maxStackElements','maxSizeOfInstructions','maxComponentElements','maxComponentDepth','maxPoints','maxContours','maxCompositePoints','maxCompositeContours']:
    setattr(t['maxp'],a,0)
t['maxp'].maxZones=1
t['head'].indexToLocFormat=0
t.save(dst)
