"""Read supplied XLSX values without modifying the workbook (standard library only)."""
import json
import posixpath
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


def read_rows(path):
    with zipfile.ZipFile(path) as z:
        strings = []
        if 'xl/sharedStrings.xml' in z.namelist():
            strings = [''.join(t.text or '' for t in si.findall('.//s:t', NS))
                       for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('s:si', NS)]
        book = ET.fromstring(z.read('xl/workbook.xml'))
        sheet = book.find('s:sheets/s:sheet', NS)
        rid = sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
        rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
        target = next(r.get('Target') for r in rels if r.get('Id') == rid)
        entry = target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/' + target)
        rows = []
        for row in ET.fromstring(z.read(entry)).findall('s:sheetData/s:row', NS):
            values = {}
            for cell in row.findall('s:c', NS):
                col = re.match('[A-Z]+', cell.get('r')).group()
                v = cell.find('s:v', NS)
                value = v.text or '' if v is not None else ''
                if cell.get('t') == 's':
                    value = strings[int(value)]
                elif cell.get('t') == 'inlineStr':
                    value = ''.join(t.text or '' for t in cell.findall('.//s:t', NS))
                if cell.find('s:f', NS) is not None:
                    raise ValueError('Source contains a formula: ' + cell.get('r'))
                values[col] = value
            if any(values.values()):
                rows.append((int(row.get('r')), values))
        headers = rows[0][1]
        return sheet.get('name'), [(number, {name: values.get(col, '') for col, name in headers.items() if name})
                                   for number, values in rows[1:]]


if __name__ == '__main__':
    for name in sys.argv[1:]:
        sheet, rows = read_rows(Path(name))
        print(json.dumps({'file': name, 'sheet': sheet, 'count': len(rows),
                          'headers': list(rows[0][1]), 'sample': rows[:2],
                          'cities': dict(Counter(r.get('城市') for _, r in rows)),
                          'missing': {h: sum(not r.get(h) for _, r in rows) for h in rows[0][1]},
                          'last': rows[-1:]}, ensure_ascii=False, indent=2))
