import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { atomicWrite, checksum } from './storage.js';

const settingsPath = root => path.join(root, 'drive-sync.json');

export async function readDriveFolder(root) {
  try {
    const { folder } = JSON.parse(await fs.readFile(settingsPath(root), 'utf8'));
    return typeof folder === 'string' && path.isAbsolute(folder) ? folder : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveDriveFolder(root, folder) {
  if (folder !== null && (typeof folder !== 'string' || !path.isAbsolute(folder) || !(await fs.stat(folder)).isDirectory())) {
    throw new Error('이미 존재하는 Google Drive 동기화 폴더를 선택해주세요.');
  }
  await atomicWrite(settingsPath(root), JSON.stringify({ folder }));
  return folder;
}

export async function syncEpub(source, folder) {
  if (!(await fs.stat(folder)).isDirectory()) throw new Error('Google Drive 동기화 폴더를 찾을 수 없습니다.');
  const { name, base, ext } = path.parse(source);
  const bytes = await fs.readFile(source);
  const sha256 = checksum(bytes);
  const names = [base, `${name} (${sha256.slice(0, 16)})${ext}`];
  for (const filename of names) {
    const destination = path.join(folder, filename);
    try {
      await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await fs.readFile(destination)).equals(bytes)) continue;
    }
    return destination;
  }
  throw new Error('동일한 이름의 다른 EPUB이 동기화 폴더에 있습니다.');
}
