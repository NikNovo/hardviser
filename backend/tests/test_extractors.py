"""Synthetic, content-free fixtures for the supported upload formats."""
import io
import struct
import zipfile

import pytest

from hardissoft_public_chat import extractors


def _zip_bytes(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return output.getvalue()


def test_extension_allowlist_and_default_kind_levels():
    assert extractors.classify('Project.STEP') == ('cad3d', 'summary')
    assert extractors.classify('layout.kicad_pcb') == ('pcb', 'summary')
    assert extractors.classify('notes.DOCX') == ('office', 'full')
    assert extractors.classify('image.png') == ('image', 'summary')
    assert extractors.classify('drawing.dxf') == ('drawing', 'summary')
    assert extractors.classify('drawing.svg') == ('drawing', 'full')
    assert extractors.classify('design.dwg') == ('stored', 'stored')
    assert extractors.classify('design.sch') == ('schematic', 'summary')
    with pytest.raises(extractors.UnsupportedFormat):
        extractors.classify('payload.exe')


def test_plain_text_decodes_with_replacement():
    text = extractors.extract('notes.txt', b'alpha\xffbeta')
    assert 'alpha\ufffdbeta' in text


def test_office_zip_extracts_document_slides_sheets_and_ods_rows():
    docx = _zip_bytes({'word/document.xml': '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Doc marker</w:t></w:r></w:p></w:body></w:document>'})
    pptx = _zip_bytes({'ppt/slides/slide1.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:t>Slide marker</a:t></p:sld>'})
    xlsx = _zip_bytes({
        'xl/workbook.xml': '<workbook xmlns="urn:x"><sheets><sheet name="Parts" sheetId="1"/></sheets></workbook>',
        'xl/sharedStrings.xml': '<sst xmlns="urn:x"><si><t>Cell marker</t></si></sst>',
        'xl/worksheets/sheet1.xml': '<worksheet xmlns="urn:x"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>',
    })
    ods = _zip_bytes({'content.xml': '<office:document-content xmlns:office="urn:o" xmlns:table="urn:t" xmlns:text="urn:x"><table:table table:name="ODS Parts"><table:table-row><table:table-cell office:value-type="string"><text:p>ODS marker</text:p></table:table-cell></table:table-row></table:table></office:document-content>'})
    odt = _zip_bytes({'content.xml': '<office:document-content xmlns:office="urn:o" xmlns:text="urn:t"><text:p>ODT marker</text:p></office:document-content>'})

    docx_text = extractors.extract('report.docx', docx)
    assert 'Doc marker' in docx_text
    assert not docx_text.startswith('[')
    assert 'Slide marker' in extractors.extract('slides.pptx', pptx)
    xlsx_text = extractors.extract('parts.xlsx', xlsx)
    assert 'Parts' in xlsx_text and 'Cell marker' in xlsx_text and '42' in xlsx_text
    assert 'ODS Parts' in extractors.extract('parts.ods', ods)
    assert 'ODS marker' in extractors.extract('parts.ods', ods)
    assert 'ODT marker' in extractors.extract('report.odt', odt)


def test_kicad_eagle_and_pcb_summaries_are_labeled_partial_content():
    kicad_sch = b'''(kicad_sch (version 20231120) (lib_id "Device:R")
      (property "Reference" "R1") (property "Value" "10k")
      (property "Footprint" "Resistor_SMD:R_0603")
      (label "SCL") (net 1 "GND") (title_block (title "Controller")))'''
    legacy_sch = b'''EESchema Schematic File Version 4\n$Descr A4 11693 8268\nTitle "Legacy controller"\n$EndDescr\n$Comp\nL Device:R R2\nF 1 "4k7"\nF 2 "Resistor_SMD:R_0603"\n$EndComp\n'''
    eagle_sch = b'''<?xml version="1.0"?><eagle><drawing><schematic><libraries/><parts><part name="U1" value="MCU" device="DIL"/></parts><sheets><sheet><nets><net name="SDA"/></nets></sheet></sheets></schematic></drawing></eagle>'''
    kicad_pcb = b'''(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 1 "GND") (footprint "R_0603" (property "Reference" "R1") (property "Value" "10k")) (gr_rect (start 1 2) (end 11 22) (layer "Edge.Cuts")))'''
    eagle_brd = b'''<eagle><drawing><board><plain/><layers><layer name="Top"/><layer name="Bottom"/></layers><elements><element name="U1" value="MCU" package="DIL"/></elements><signals><signal name="GND"/></signals></board></drawing></eagle>'''

    for name, source, markers in (
        ('board.kicad_sch', kicad_sch, ('R1', '10k', 'SCL', 'Controller')),
        ('board.sch', legacy_sch, ('R2', '4k7', 'Legacy controller')),
        ('board.sch', eagle_sch, ('U1', 'MCU', 'SDA')),
        ('board.kicad_pcb', kicad_pcb, ('R1', '10k', 'F.Cu', 'B.Cu', 'GND')),
        ('board.brd', eagle_brd, ('U1', 'MCU', 'Top', 'Bottom', 'GND')),
    ):
        summary = extractors.extract(name, source)
        assert summary.startswith('[')
        assert all(marker in summary for marker in markers)


def test_gerber_excellon_step_iges_and_mesh_summaries():
    gerber = b'%FSLAX24Y24*%\n%MOMM*%\n%TF.FileFunction,Copper,L1,Top*%\n%ADD10C,0.500*%\n'
    excellon = b'M48\nMETRIC,TZ\nT01C0.800\n%\nT01\nX010000Y020000\nX030000Y040000\nM30\n'
    step = b'''ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('STEP marker'),'2;1');\nFILE_NAME('model.step','',('author'),('org'),'tool','Origin system','');\nENDSEC;\nDATA;\n#1=PRODUCT('id','Part marker','',());\nENDSEC;\nEND-ISO-10303-21;\n'''
    iges = (b'Start section'.ljust(72) + b'S      1\n'
            + b'Global parameter text'.ljust(72) + b'G      1\n'
            + b'     116'.ljust(72) + b'D      1\n')
    ascii_stl = b'solid test\nfacet normal 0 0 1\nouter loop\nvertex 1 2 3\nvertex 4 5 6\nvertex 0 2 1\nendloop\nendfacet\nendsolid test\n'
    binary_stl = b'Binary fixture'.ljust(80, b' ') + struct.pack('<I', 1) + struct.pack('<12fH', 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0)
    obj = b'o Object marker\ng Group marker\nv 1 2 3\nv 4 5 6\nf 1 2 1\n'

    expectations = (
        ('board.gbr', gerber, ('Top', 'mm', 'aperture count')),
        ('drill.drl', excellon, ('metric', 'hole count: 2')),
        ('model.step', step, ('Part marker', 'Originating system')),
        ('model.iges', iges, ('Global parameter text', '116')),
        ('ascii.stl', ascii_stl, ('triangles: 1', 'bounding box (mm)')),
        ('binary.stl', binary_stl, ('triangles: 1', 'bounding box (mm)')),
        ('model.obj', obj, ('Object marker', 'Group marker', 'vertices: 2', 'faces: 1')),
    )
    for name, source, markers in expectations:
        summary = extractors.extract(name, source)
        assert summary.startswith('[')
        assert all(marker.casefold() in summary.casefold() for marker in markers)


def test_3mf_freecad_dxf_svg_and_image_summaries():
    three_mf = _zip_bytes({'3D/3dmodel.model': '<model unit="millimeter"><resources><object id="1" name="Bracket marker"/></resources><build/></model>'})
    freecad = _zip_bytes({'Document.xml': '<Document><Objects><Object name="Body"><Properties><Property name="Label"><String value="FreeCAD marker"/></Property></Properties></Object></Objects></Document>'})
    dxf = b'''0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nLAYER\n2\nOutline marker\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nTEXT\n1\nDXF marker\n0\nENDSEC\n0\nEOF\n'''
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"><title>SVG marker</title><desc>description marker</desc><text>label marker</text></svg>'
    png = b'\x89PNG\r\n\x1a\n' + b'\x00\x00\x00\rIHDR' + struct.pack('>II', 23, 19) + b'\x08\x02\x00\x00\x00'
    gif = b'GIF89a' + struct.pack('<HH', 17, 9) + b'\x00\x00\x00'
    jpeg = b'\xff\xd8\xff\xc0\x00\x11\x08' + struct.pack('>HH', 13, 29) + b'\x03' + b'\x01\x11\x00' * 3 + b'\xff\xd9'
    webp = b'RIFF' + struct.pack('<I', 22) + b'WEBPVP8X' + struct.pack('<I', 10) + b'\x00\x00\x00\x00' + (22).to_bytes(3, 'little') + (18).to_bytes(3, 'little')

    for name, source, markers in (
        ('part.3mf', three_mf, ('Bracket marker', 'millimeter')),
        ('part.fcstd', freecad, ('FreeCAD marker',)),
        ('drawing.dxf', dxf, ('Outline marker', 'DXF marker', '$INSUNITS')),
        ('drawing.svg', svg, ('SVG marker', 'description marker', 'label marker')),
        ('x.png', png, ('23', '19')),
        ('x.gif', gif, ('17', '9')),
        ('x.jpg', jpeg, ('29', '13')),
        ('x.jpeg', jpeg, ('29', '13')),
        ('x.webp', webp, ('23', '19')),
    ):
        text = extractors.extract(name, source)
        if name.endswith('.svg'):
            assert not text.startswith('[')
        else:
            assert text.startswith('[')
        assert all(marker.casefold() in text.casefold() for marker in markers)


def test_stored_kind_metadata_and_zip_xml_safety_limits():
    stored = extractors.extract('prototype.dwg', b'not parsed proprietary bytes', size_bytes=27,
                                sha256='0123456789abcdef' * 4)
    assert stored.startswith('[Stored DWG — content not readable]')
    assert 'Name: prototype.dwg' in stored
    assert 'Kind: stored' in stored
    assert 'Size: 27 bytes' in stored
    assert 'SHA-256: 0123456789abcdef' in stored

    entity_bomb = b'<!DOCTYPE svg [<!ENTITY x "expanded">]><svg>&x;</svg>'
    with pytest.raises(extractors.ExtractionError, match='unsafe XML'):
        extractors.extract('bad.svg', entity_bomb)
    utf16_entity_bomb = entity_bomb.decode('ascii').encode('utf-16')
    with pytest.raises(extractors.ExtractionError, match='unsafe XML'):
        extractors.extract('bad.svg', utf16_entity_bomb)

    archive = _zip_bytes({'../escape.xml': '<root>bad</root>'})
    with pytest.raises(extractors.ExtractionError, match='unsafe archive'):
        extractors.extract('bad.docx', archive)

    compressed_bomb = io.BytesIO()
    with zipfile.ZipFile(compressed_bomb, 'w') as archive:
        archive.writestr('word/document.xml', b'x')
    bomb = bytearray(compressed_bomb.getvalue())
    central = bomb.index(b'PK\x01\x02')
    local = bomb.index(b'PK\x03\x04')
    struct.pack_into('<I', bomb, central + 24, 200 * 1024 * 1024 + 1)
    struct.pack_into('<I', bomb, local + 22, 200 * 1024 * 1024 + 1)
    with pytest.raises(extractors.ExtractionError, match='archive limits'):
        extractors.extract('bomb.docx', bytes(bomb))

    many_members = _zip_bytes({'member-%04d.xml' % index: b'<root/>' for index in range(2001)})
    with pytest.raises(extractors.ExtractionError, match='unsafe archive'):
        extractors.extract('too-many.docx', many_members)


def test_extracted_text_is_capped_before_chunking():
    text = extractors.extract('large.txt', b'x' * (extractors.MAX_EXTRACTED_TEXT_BYTES + 1024))
    assert len(text.encode('utf-8')) <= extractors.MAX_EXTRACTED_TEXT_BYTES
