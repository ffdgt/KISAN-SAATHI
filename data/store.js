import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'db.json');

const defaultDB = {
  users: [],
  workers: [],
  jobs: [],
  invites: []
};

export function loadDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      fs.writeFileSync(DB_PATH, JSON.stringify(defaultDB, null, 2));
      return JSON.parse(JSON.stringify(defaultDB));
    }
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    const parsed = raw ? JSON.parse(raw) : {};
    return { ...defaultDB, ...parsed };
  } catch (e) {
    console.error('Failed to read DB, resetting.', e);
    return JSON.parse(JSON.stringify(defaultDB));
  }
}

export function saveDB(db) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Failed to write DB', e);
  }
}

