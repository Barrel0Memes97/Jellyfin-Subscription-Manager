#!/usr/bin/env python3
"""Update a Jellyfin plugin repository manifest from a GitHub Release archive.

No external dependencies. This does not sign the DLL: Jellyfin requires the
archive checksum, not an Authenticode/strong-name signature.
"""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import re

PLUGIN_ID = 'd86ea639-fd20-458d-b4ae-ac8b74c8c0ca'
TARGET_ABI = '12.4.0.0'


def update_manifest(data, archive, version, repository, tag, timestamp=None):
    if not re.fullmatch(r'\d+\.\d+\.\d+\.\d+', version):
        raise ValueError('Version must have four numeric components')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('Repository must be owner/name')
    if tag != 'v' + version:
        raise ValueError('Tag must match v' + version)
    checksum = hashlib.md5(Path(archive).read_bytes()).hexdigest().upper()
    file_name = Path(archive).name
    source_url = f'https://github.com/{repository}/releases/download/{tag}/{file_name}'
    publication = timestamp or datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    plugins = list(data)
    plugin = next((p for p in plugins if p.get('guid') == PLUGIN_ID), None)
    if plugin is None:
        plugin = {
            'category': 'General',
            'guid': PLUGIN_ID,
            'name': 'Subscription Manager',
            'description': 'Manage Jellyfin subscription plans, payments, user permissions, Seerr requests, and banners.',
            'overview': 'Subscription Manager for Jellyfin',
            'owner': repository.split('/')[0],
            'versions': [],
        }
        plugins.append(plugin)
    plugin['owner'] = repository.split('/')[0]
    plugin['versions'] = [v for v in plugin['versions'] if not (
        v.get('version') == version and v.get('targetAbi') == TARGET_ABI)]
    plugin['versions'].insert(0, {
        'changelog': f'Subscription Manager {version} for Jellyfin 12.4. Plan permissions, account balances, Seerr integration and banners.',
        'targetAbi': TARGET_ABI,
        'version': version,
        'sourceUrl': source_url,
        'checksum': checksum,
        'timestamp': publication,
    })
    plugin['versions'].sort(key=lambda v: tuple(int(x) for x in v['version'].split('.')), reverse=True)
    return plugins


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--manifest', required=True)
    p.add_argument('--archive', required=True)
    p.add_argument('--version', required=True)
    p.add_argument('--repository', required=True)
    p.add_argument('--tag', required=True)
    args = p.parse_args()
    dest = Path(args.manifest)
    data = json.loads(dest.read_text(encoding='utf-8')) if dest.exists() else []
    if not isinstance(data, list):
        raise ValueError('Manifest must contain a list of plugins')
    updated = update_manifest(data, args.archive, args.version, args.repository, args.tag)
    dest.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Updated {dest}: version {args.version} / ABI {TARGET_ABI}')


if __name__ == '__main__':
    main()
