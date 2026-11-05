"""Import supplied XLSX values after validation; retain a data rollback copy."""
import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import shutil
from urllib.parse import urlsplit
from inspect_workbook import read_rows

ROOT = Path(__file__).resolve().parents[1]
FIELDS = {'id': '景点ID', 'name': '景点名称', 'city': '城市', 'tags': '标签',
          'intro': '简介', 'match_reason': '适配理由', 'caution': '限制提醒',
          'season': '推荐季节', 'image': '图片链接', 'source': '事实来源',
          'verified_date': '核验日期', 'license': '素材授权', 'note': '素材对应说明'}


def convert(source):
    sheet, rows = read_rows(source)
    records = []
    for number, row in rows:
        missing = [header for header in FIELDS.values() if header not in row]
        if missing:
            raise ValueError('Missing columns: ' + ', '.join(missing))
        item = {key: str(row[header]).strip() for key, header in FIELDS.items()}
        for key in ('id', 'name', 'city', 'tags', 'intro'):
            if not item[key]:
                raise ValueError(f'Row {number}: empty {key}')
        item['tags'] = [v.strip() for v in re.split(r'[,，、;；]', item['tags']) if v.strip()]
        for key in ('image', 'source'):
            url = urlsplit(item[key])
            if item[key] and (url.scheme not in ('http', 'https') or not url.netloc):
                raise ValueError(f'Row {number}: invalid {key} URL')
        records.append(item)
    for key in ('id', 'name'):
        duplicates = [k for k, count in Counter(r[key] for r in records).items() if count > 1]
        if duplicates:
            raise ValueError(f'Duplicate {key}: {duplicates}')
    return sheet, records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    sheet, records = convert(args.source)
    destination = ROOT / 'data/attractions.json'
    old = json.loads(destination.read_text(encoding='utf-8'))
    by_id = {r['id']: r for r in records}
    for item in old:
        if item['id'] not in by_id or any(item[k] != by_id[item['id']][k] for k in ('name', 'city')):
            raise ValueError('Existing ID changed or missing: ' + item['id'])
    report = {
        'source_workbook': args.source.name, 'source_sheet': sheet,
        'source_sha256': hashlib.sha256(args.source.read_bytes()).hexdigest(),
        'old_count': len(old), 'new_count': len(records),
        'added_ids': [r['id'] for r in records if r['id'] not in {o['id'] for o in old}],
        'cities': dict(Counter(r['city'] for r in records)),
        'source_homepage_ids': [r['id'] for r in records if urlsplit(r['source']).path in ('', '/')],
        'short_image_link_ids': [r['id'] for r in records if urlsplit(r['image']).hostname == 'aka.doubaocdn.com'],
        'missing_fields': {k: [r['id'] for r in records if not r[k]] for k in FIELDS},
        'validation': 'Local structure and source-cell equality only; no live URL, fact, image correspondence or licensing verification.',
        'source_date_note': 'verified_date is copied from the supplied sheet, not a new independent verification date.'
    }
    if args.apply:
        backup = ROOT / 'backups' / ('data-before-import-' + datetime.now().strftime('%Y%m%d-%H%M%S'))
        backup.mkdir(parents=True)
        for rel in ('data/attractions.json', 'data/attributes.json', '待核验清单.md'):
            path = ROOT / rel
            if path.exists():
                shutil.copyfile(path, backup / path.name)
        destination.write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        (ROOT / 'checks').mkdir(exist_ok=True)
        (ROOT / 'checks/data-import.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print('Imported', len(records), 'records. Backup:', backup.name)
    else:
        print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == '__main__':
    main()
