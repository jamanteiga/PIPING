# Genera la plantilla DXF R2000 (AC1015) de PIPING con las capas normalizadas de José.
import ezdxf, io, json
doc = ezdxf.new('R2000', units=4)  # mm
doc.header['$MEASUREMENT'] = 1
doc.header['$LWDISPLAY'] = 1
doc.header['$LTSCALE'] = 1.0
doc.linetypes.add('Trazado', pattern=[15.0, 12.0, -3.0], description='Trazado ____ ____ ____')
doc.linetypes.add('Trazado y punto', pattern=[27.5, 24.0, -3.0, 0.0, -0.5, 0.0, -3.0] if False else [30.5, 24.0, -3.0, 0.5, -3.0], description='Trazado y punto ____ . ____ . ____')
CAPAS = [  # nombre, ACI, rgb, tipo de línea, grosor (1/100 mm)
    ('0', 7, (255, 255, 255), 'Continuous', 20),
    ('Bord', 2, (255, 255, 0), 'Continuous', 70),
    ('Dim', 6, (255, 0, 255), 'Continuous', 30),
    ('Hid', 1, (255, 0, 0), 'Trazado', 20),
    ('Hidden', 5, (0, 0, 255), 'Trazado y punto', 25),
    ('Marca', 7, (255, 255, 255), 'Continuous', 35),
    ('Object', 7, (255, 255, 255), 'Continuous', 35),
    ('Text', 3, (0, 255, 0), 'Continuous', 35),
    ('Tratt', 5, (0, 0, 255), 'Continuous', 15),
]
for n, aci, rgb, lt, lw in CAPAS:
    lay = doc.layers.get('0') if n == '0' else doc.layers.add(n)
    lay.color = aci; lay.dxf.linetype = lt; lay.dxf.lineweight = lw
msp = doc.modelspace()
s = io.StringIO(); doc.write(s); txt = s.getvalue()
i = txt.index('\nENTITIES\n'); j = txt.index('ENDSEC', i)
cab = txt[: i + len('\nENTITIES\n')]
pie = txt[j - 3 :] if txt[j-3:j] == '  0' else None
# separar exactamente: cabecera hasta "ENTITIES", pie desde el "  0\nENDSEC" del final de ENTITIES
k = txt.rfind('  0\n', i, j)
cab = txt[: i + len('\nENTITIES\n')]
pie = txt[k:]
seed = doc.header['$HANDSEED']
json.dump({'cabecera': cab, 'pie': pie, 'modelo': doc.block_records.get('*Model_Space').dxf.handle, 'seed': seed}, open('plantilla.json', 'w'))
print(len(cab), len(pie), doc.block_records.get('*Model_Space').dxf.handle, seed)
