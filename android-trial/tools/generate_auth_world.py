#!/usr/bin/env python3
"""Generate the locally bundled, original GOAL$GAMBIT 3D authentication world.

The GLB is built from authored polygon meshes and PBR materials; it has no
remote assets or third-party model dependencies.
"""
import json
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), "..", "app", "src", "main", "assets", "models", "auth_world.glb")
blob = bytearray()
views, accessors, meshes, nodes, materials = [], [], [], [], []

def align4():
    while len(blob) % 4:
        blob.append(0)

def add_material(name, rgba, metallic=0.0, roughness=0.5, emissive=None, alpha=None):
    m = {"name": name, "pbrMetallicRoughness": {"baseColorFactor": rgba, "metallicFactor": metallic, "roughnessFactor": roughness}}
    if emissive:
        m["emissiveFactor"] = emissive
    if alpha:
        m["alphaMode"] = alpha
        m["doubleSided"] = True
    materials.append(m)
    return len(materials) - 1

GOLD = add_material("Polished championship gold", [0.88, 0.57, 0.13, 1], .42, .32, [.06, .026, .003])
GOLD_BRIGHT = add_material("Warm illuminated gold", [1, .73, .22, 1], .68, .23, [.24, .10, .018])
BLACK = add_material("Anodized obsidian", [.018, .02, .026, 1], .55, .25)
STEEL = add_material("Brushed titanium", [.48, .53, .58, 1], .82, .24)
WHITE = add_material("Ivory leather", [.91, .88, .8, 1], .04, .43)
BALL_BLACK = add_material("Football charcoal panels", [.025, .027, .031, 1], .04, .46)
FLOOR = add_material("Arena midnight stone", [.035, .038, .043, 1], .28, .33)
GLOW = add_material("Volumetric golden beam", [1, .77, .34, .16], .0, .4, [.2, .12, .035], "BLEND")
GLASS = add_material("Optical lens glass", [.95, .89, .62, .62], .18, .13, [.16, .11, .025], "BLEND")

def add_accessor(data, component_type, kind, count, target, minimum=None, maximum=None):
    align4()
    offset = len(blob)
    blob.extend(data)
    views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(data), "target": target})
    accessor = {"bufferView": len(views)-1, "componentType": component_type, "count": count, "type": kind}
    if minimum is not None: accessor["min"] = minimum
    if maximum is not None: accessor["max"] = maximum
    accessors.append(accessor)
    return len(accessors)-1

def add_node(name, mesh=None, children=None, translation=None):
    n = {"name": name}
    if mesh is not None: n["mesh"] = mesh
    if children: n["children"] = children
    if translation is not None: n["translation"] = translation
    nodes.append(n)
    return len(nodes)-1

def add_mesh(name, vertices, faces, material, parent=None):
    # Smooth normals are averaged at shared vertices. Meshes with deliberate hard
    # edges use duplicated vertices in their authoring routines.
    sums = [[0.0, 0.0, 0.0] for _ in vertices]
    for face in faces:
        a, b, c = (vertices[i] for i in face[:3])
        u = [b[k]-a[k] for k in range(3)]; v = [c[k]-a[k] for k in range(3)]
        normal = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]]
        for i in face:
            for k in range(3): sums[i][k] += normal[k]
    normals = []
    for n in sums:
        length = math.sqrt(sum(x*x for x in n)) or 1
        normals.append([x/length for x in n])
    flat_pos = [x for v in vertices for x in v]
    flat_nrm = [x for v in normals for x in v]
    posbytes = struct.pack("<" + "f"*len(flat_pos), *flat_pos)
    nrmbytes = struct.pack("<" + "f"*len(flat_nrm), *flat_nrm)
    idx = [i for face in faces for i in face]
    idbytes = struct.pack("<" + "I"*len(idx), *idx)
    # Every authored mesh includes UV coordinates. Most rely on solid PBR
    # factors; the arena floor uses the locally embedded stone texture below.
    uvbytes = struct.pack("<" + "f"*(len(vertices)*2), *(coord for v in vertices for coord in (v[0]*.42, v[2]*.42)))
    lo = [min(v[k] for v in vertices) for k in range(3)]
    hi = [max(v[k] for v in vertices) for k in range(3)]
    pa = add_accessor(posbytes, 5126, "VEC3", len(vertices), 34962, lo, hi)
    na = add_accessor(nrmbytes, 5126, "VEC3", len(vertices), 34962)
    ia = add_accessor(idbytes, 5125, "SCALAR", len(idx), 34963)
    ua = add_accessor(uvbytes, 5126, "VEC2", len(vertices), 34962)
    mesh = len(meshes)
    meshes.append({"name": name, "primitives": [{"attributes": {"POSITION": pa, "NORMAL": na, "TEXCOORD_0": ua}, "indices": ia, "material": material, "mode": 4}]})
    node = add_node(name, mesh=mesh)
    if parent is not None:
        nodes[parent].setdefault("children", []).append(node)
    return node

def uv_sphere(cx, cy, cz, rx, ry, rz, seg=32, rings=20):
    verts=[]; faces=[]
    for j in range(rings+1):
        lat=-math.pi/2+math.pi*j/rings
        for i in range(seg):
            lon=2*math.pi*i/seg
            verts.append([cx+rx*math.cos(lat)*math.cos(lon), cy+ry*math.sin(lat), cz+rz*math.cos(lat)*math.sin(lon)])
    for j in range(rings):
        for i in range(seg):
            a=j*seg+i; b=j*seg+(i+1)%seg; c=(j+1)*seg+(i+1)%seg; d=(j+1)*seg+i
            if j: faces.append([a,b,d])
            if j<rings-1: faces.append([b,c,d])
    return verts,faces

def cylinder(cx, cy, cz, radius, height, material, parent=None, sides=32, axis="y", r2=None):
    r2 = radius if r2 is None else r2
    verts=[]; faces=[]
    for y,r in [(-height/2,radius),(height/2,r2)]:
        for i in range(sides):
            a=2*math.pi*i/sides
            if axis=="y": verts.append([cx+math.cos(a)*r,cy+y,cz+math.sin(a)*r])
            else: verts.append([cx+math.cos(a)*r,cy+math.sin(a)*r,cz+y])
    for i in range(sides):
        a=i; b=(i+1)%sides; c=sides+b; d=sides+a
        faces.extend([[a,d,b],[b,d,c]])
    faces.append(list(range(sides-1,-1,-1))); faces.append(list(range(sides,sides*2)))
    return add_mesh("Cylinder",verts,faces,material,parent)

def box(cx, cy, cz, sx, sy, sz, material, parent=None):
    x=sx/2; y=sy/2; z=sz/2
    v=[[-x,-y,-z],[x,-y,-z],[x,y,-z],[-x,y,-z],[-x,-y,z],[x,-y,z],[x,y,z],[-x,y,z]]
    v=[[p[0]+cx,p[1]+cy,p[2]+cz] for p in v]
    f=[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]]
    return add_mesh("Box",v,f,material,parent)

def extruded_wordmark(parent):
    glyphs={
        "G":["01110","10000","10000","10111","10001","10001","01110"],
        "O":["01110","10001","10001","10001","10001","10001","01110"],
        "A":["01110","10001","10001","11111","10001","10001","10001"],
        "L":["10000","10000","10000","10000","10000","10000","11111"],
        "$":["00100","01111","10100","01110","00101","11110","00100"],
        "M":["10001","11011","10101","10101","10001","10001","10001"],
        "B":["11110","10001","10001","11110","10001","10001","11110"],
        "I":["11111","00100","00100","00100","00100","00100","11111"],
        "T":["11111","00100","00100","00100","00100","00100","00100"]}
    word="GOAL$GAMBIT"; sx=.022; sy=.025; gap=.006
    width=len(word)*(5*sx+gap)-gap
    verts=[]; faces=[]
    def cube(cx,cy,cz,dx,dy,dz):
        start=len(verts);x=dx/2;y=dy/2;z=dz/2
        verts.extend([[cx-x,cy-y,cz-z],[cx+x,cy-y,cz-z],[cx+x,cy+y,cz-z],[cx-x,cy+y,cz-z],[cx-x,cy-y,cz+z],[cx+x,cy-y,cz+z],[cx+x,cy+y,cz+z],[cx-x,cy+y,cz+z]])
        faces.extend([[start+0,start+2,start+1],[start+0,start+3,start+2],[start+4,start+5,start+6],[start+4,start+6,start+7],[start+0,start+1,start+5],[start+0,start+5,start+4],[start+3,start+7,start+6],[start+3,start+6,start+2],[start+0,start+4,start+7],[start+0,start+7,start+3],[start+1,start+2,start+6],[start+1,start+6,start+5]])
    for ci,ch in enumerate(word):
        for row,bits in enumerate(glyphs[ch]):
            for col,bit in enumerate(bits):
                if bit=="1": cube(-width/2+ci*(5*sx+gap)+col*sx+sx/2, .075-row*sy, .19, sx*.84,sy*.84,.026)
    add_mesh("Extruded GOAL$GAMBIT wordmark",verts,faces,GOLD_BRIGHT,parent)

def lathe(profile, parent, material=GOLD, sides=48):
    v=[]; f=[]
    for y,r in profile:
        for i in range(sides):
            a=2*math.pi*i/sides
            v.append([math.cos(a)*r,y,math.sin(a)*r])
    for j in range(len(profile)-1):
        for i in range(sides):
            a=j*sides+i; b=j*sides+(i+1)%sides; c=(j+1)*sides+(i+1)%sides; d=(j+1)*sides+i
            f.extend([[a,d,b],[b,d,c]])
    f += [list(range(sides-1,-1,-1)),list(range((len(profile)-1)*sides,len(profile)*sides))]
    return add_mesh("Lathed king body",v,f,material,parent)

def torus(center, major, minor, parent, material=GOLD_BRIGHT, seg=64, tube=10, axis="y"):
    cx,cy,cz=center; v=[]; f=[]
    for i in range(seg):
        a=2*math.pi*i/seg
        for j in range(tube):
            b=2*math.pi*j/tube
            rr=major+minor*math.cos(b)
            if axis=="y": v.append([cx+rr*math.cos(a),cy+minor*math.sin(b),cz+rr*math.sin(a)])
            else: v.append([cx+rr*math.cos(a),cy+rr*math.sin(a),cz+minor*math.sin(b)])
    for i in range(seg):
        for j in range(tube):
            a=i*tube+j; b=i*tube+(j+1)%tube; c=((i+1)%seg)*tube+(j+1)%tube; d=((i+1)%seg)*tube+j
            if axis=="y": f.extend([[a,b,d],[b,c,d]])
            else: f.extend([[a,d,b],[b,d,c]])
    return add_mesh("Architectural gold ring",v,f,material,parent)

def cone_mesh(parent, length=1.8, radius=.55, material=GLOW, sides=32):
    # Beam axis points along local +Y from the lamp head.
    v=[]; f=[]
    for y,r in [(0,.045),(length,radius)]:
        for i in range(sides):
            a=2*math.pi*i/sides
            v.append([math.cos(a)*r,y,math.sin(a)*r])
    for i in range(sides):
        a=i;b=(i+1)%sides;f.append([a,sides+b,b]);f.append([a,sides+a,sides+b])
    return add_mesh("Focused translucent torch beam",v,f,material,parent)

# Dark 3D stage and tunnel, with nested portals that provide true parallax.
world = add_node("World")
box(0,-2.65,-1.5,5.4,.20,8.0,FLOOR,world)
for z,rad in [(-3.45,1.20),(-2.75,1.03),(-2.05,.87),(-1.35,.70)]:
    torus((0,.0,z),rad,.075,world,GOLD_BRIGHT if z==-3.45 else GOLD,72,12,axis="z")
for side in [-1,1]:
    box(side*1.43,-.45,-2.3,.12,2.25,3.2,BLACK,world)
    for i in range(5):
        box(side*1.35,-.7+i*.43,-2.3,.11,.035,2.8,GOLD if i%2==0 else STEEL,world)
box(0,-2.48,-2.6,2.95,.04,4.6,GOLD,world)
for i in range(9):
    box(0,-2.40,-4.35+i*.43,2.75,.012,.018,GOLD_BRIGHT if i%2==0 else STEEL,world)
# 3D championship plaque and geometric crest above the king.
logo=add_node("Goal Gambit three-dimensional crest",translation=[0,1.83,-.55])
box(0,0,0,1.78,.43,.18,BLACK,logo)
box(0,0,.105,1.66,.33,.035,GOLD,logo)
box(0,0,.13,1.56,.26,.025,BLACK,logo)
torus((0,0,.17),.115,.025,logo,GOLD_BRIGHT,36,8)
extruded_wordmark(logo)
for angle in range(0,360,60):
    a=math.radians(angle)
    cylinder(math.sin(a)*.085,math.cos(a)*.085,.19,.014,.035,GOLD_BRIGHT,logo,sides=10,axis="z")

# Hanging string and one assembled king mesh, authored as smooth 3D geometry.
hook=add_node("King hanging point",translation=[0,1.37,-.12])
cylinder(0,.17,0,.012,.32,GOLD,hook,sides=8)
king=add_node("KingPivot",translation=[0,1.17,-.10])
lathe([(-.82,.22),(-.78,.34),(-.71,.34),(-.67,.22),(-.58,.17),(-.48,.13),(-.34,.12),(-.30,.23),(-.24,.25),(-.20,.14),(-.11,.10),(-.07,.21),(-.025,.20),(0,.12)],king)
torus((0,-.76,0),.285,.028,king,GOLD_BRIGHT)
torus((0,-.25,0),.215,.025,king,GOLD_BRIGHT)
torus((0,-.08,0),.205,.023,king,GOLD_BRIGHT)
for side in [-1,1]:
    cylinder(side*.23,-.47,0,.065,.35,GOLD,king,sides=16,axis="z")
    uv,uf=uv_sphere(side*.24,-.48,0,.075,.09,.075,16,10)
    add_mesh("King glove",uv,uf,GOLD_BRIGHT,king)
# Crown with eight separate raised points and jewel.
torus((0,.0,0),.15,.025,king,GOLD_BRIGHT)
for i in range(8):
    a=2*math.pi*i/8
    x,z=math.cos(a)*.16,math.sin(a)*.16
    cylinder(x,.075,z,.024,.16,GOLD_BRIGHT,king,sides=10,r2=.006)
uv,uf=uv_sphere(0,.12,0,.045,.055,.045,16,10)
add_mesh("Crown sapphire",uv,uf,STEEL,king)

# Actual metallic LED flashlight with one continuously tracked fixture/beam.
torch=add_node("FlashlightRoot",translation=[.67,-2.08,.20])
cylinder(0,0,0,.105,.62,BLACK,torch,sides=40)
cylinder(0,.30,0,.15,.17,STEEL,torch,sides=40,r2=.125)
cylinder(0,.40,0,.13,.06,GOLD_BRIGHT,torch,sides=40)
uv,uf=uv_sphere(0,.435,0,.098,.028,.098,24,12)
add_mesh("LED optical lens",uv,uf,GLASS,torch)
for y in [-.18,-.12,-.06,.00,.06,.12]: torus((0,y,0),.106,.008,torch,STEEL,36,6)
cone_mesh(torch,1.85,.56,GLOW,40)

# 3D football with a full spherical shell and raised pentagonal inlays.
ball=add_node("MatchBallRoot",translation=[-.82,-1.57,.45])
verts,faces=uv_sphere(0,0,0,.39,.39,.39,64,40)
add_mesh("Regulation spherical football",verts,faces,WHITE,ball)
def normalized(v):
    n=math.sqrt(sum(t*t for t in v)); return [t/n for t in v]
golden=(1+math.sqrt(5))/2
centers=[]
for s1 in [-1,1]:
    for s2 in [-1,1]:
        centers += [[0,s1,s2*golden],[s1,s2*golden,0],[s1*golden,0,s2]]
for c in centers:
    n=normalized(c); ref=[0,1,0] if abs(n[1])<.9 else [1,0,0]
    u=normalized([n[1]*ref[2]-n[2]*ref[1],n[2]*ref[0]-n[0]*ref[2],n[0]*ref[1]-n[1]*ref[0]])
    v=[n[1]*u[2]-n[2]*u[1],n[2]*u[0]-n[0]*u[2],n[0]*u[1]-n[1]*u[0]]
    pv=[[(n[k]*.391+u[k]*math.cos(2*math.pi*j/5)*.105+v[k]*math.sin(2*math.pi*j/5)*.105) for k in range(3)] for j in range(5)]
    add_mesh("Raised five-sided ball panel",pv,[[0,i,i+1] for i in range(1,4)],BALL_BLACK,ball)
torus((0,0,.392),.392,.004,ball,BLACK,64,6,axis="z")

# Independent 3D text objects are represented by a bold, physical crest block;
# the native accessible wordmark remains the readable GOAL$GAMBIT text overlay.

# A genuine punctual spotlight is attached to the flashlight via glTF extension.
light_id=0
spot_node=add_node("FlashlightSpotlight",translation=[0,.44,0])
nodes[spot_node]["rotation"]=[.7071068,0,0,.7071068]
nodes[torch]["children"].append(spot_node)
nodes[spot_node]["extensions"]={"KHR_lights_punctual":{"light":light_id}}
root_nodes=[world,logo,hook,king,torch,ball]
# A subtle, seamless procedural stone texture keeps the arena floor tactile.
def make_stone_png(size=128):
    raw=bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            gx=x%32; gy=y%32
            seam = gx < 1 or gy < 1 or (y//32)%2==1 and gx == 16
            variation=int(2*math.sin(x*.39+y*.23)+2*math.sin(x*.11-y*.31))
            base=13 if seam else 23+variation
            raw.extend((max(0,min(255,base)),max(0,min(255,base+1)),max(0,min(255,base+3)),255))
    def chunk(kind,data): return struct.pack(">I",len(data))+kind+data+struct.pack(">I",zlib.crc32(kind+data)&0xffffffff)
    return b"\x89PNG\r\n\x1a\n"+chunk(b"IHDR",struct.pack(">2I5B",size,size,8,6,0,0,0))+chunk(b"IDAT",zlib.compress(bytes(raw),9))+chunk(b"IEND",b"")

png=make_stone_png()
align4(); image_offset=len(blob); blob.extend(png)
stone_image_view=len(views); views.append({"buffer":0,"byteOffset":image_offset,"byteLength":len(png)})
materials[FLOOR]["pbrMetallicRoughness"]["baseColorTexture"]={"index":0}
doc={
 "asset":{"version":"2.0","generator":"GOAL$GAMBIT original procedural PBR scene"},
 "extensionsUsed":["KHR_lights_punctual"],
 "extensions":{"KHR_lights_punctual":{"lights":[{"type":"spot","color":[1.0,.79,.42],"intensity":1200,"range":7,"spot":{"innerConeAngle":.12,"outerConeAngle":.50}}]}},
 "scene":0,"scenes":[{"name":"GOAL$GAMBIT auth arena","nodes":root_nodes}],
 "nodes":nodes,"meshes":meshes,"materials":materials,
 "images":[{"name":"Authored dark arena stone","bufferView":stone_image_view,"mimeType":"image/png"}],
 "textures":[{"sampler":0,"source":0}],"samplers":[{"magFilter":9729,"minFilter":9987,"wrapS":10497,"wrapT":10497}],
 "accessors":accessors,"bufferViews":views,"buffers":[{"byteLength":0}]
}
doc["buffers"][0]["byteLength"]=len(blob)
json_bytes=json.dumps(doc,separators=(",",":"),ensure_ascii=False).encode("utf-8")
while len(json_bytes)%4: json_bytes+=b" "
align4()
bin_bytes=bytes(blob)
total=12+8+len(json_bytes)+8+len(bin_bytes)
glb=struct.pack("<4sII",b"glTF",2,total)+struct.pack("<I4s",len(json_bytes),b"JSON")+json_bytes+struct.pack("<I4s",len(bin_bytes),b"BIN\x00")+bin_bytes
os.makedirs(os.path.dirname(OUT),exist_ok=True)
with open(OUT,"wb") as f:f.write(glb)
print(f"Wrote {OUT} ({len(glb)} bytes), {len(meshes)} meshes, {len(nodes)} nodes, {len(materials)} PBR materials")
