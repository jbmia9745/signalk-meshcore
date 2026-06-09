// Persistent node database, keyed on contact public key (hex).
// Replaces the Meshtastic node-number keyed DB. Each entry:
//   { name, type, seen (Date), advLat, advLon, mmsi? }
// Position values are stored in degrees (adverts carry int32 microdegrees;
// callers divide by 1e6 before storing — spec §10.5).
const { readFile, writeFile } = require('fs/promises');

const DE_PATTERN = /.* DE ([A-Z0-9]{4,})$/;

class NodeDb {
  constructor(filePath, log) {
    this.filePath = filePath;
    this.log = log || (() => {});
    this.nodes = {};
  }

  async load() {
    let raw;
    try {
      raw = await readFile(this.filePath, 'utf-8');
    } catch (e) {
      return; // first run
    }
    try {
      const data = JSON.parse(raw);
      Object.keys(data).forEach((key) => {
        this.nodes[key] = data[key];
        if (data[key].seen) {
          this.nodes[key].seen = new Date(data[key].seen);
        }
      });
    } catch (e) {
      this.log(`Node DB unreadable, starting fresh: ${e.message}`);
    }
  }

  save() {
    return writeFile(this.filePath, JSON.stringify(this.nodes, null, 2), 'utf-8')
      .catch((e) => this.log(`Failed to store node DB: ${e.message}`));
  }

  // contact: meshcore.js contact shape (publicKey Uint8Array, advName,
  // type, lastAdvert epoch secs, advLat/advLon microdegrees)
  updateFromContact(contact) {
    const key = Buffer.from(contact.publicKey).toString('hex');
    if (!this.nodes[key]) {
      this.nodes[key] = {};
    }
    const node = this.nodes[key];
    node.name = contact.advName;
    node.type = contact.type;
    if (contact.lastAdvert) {
      node.seen = new Date(contact.lastAdvert * 1000);
    }
    if (Number.isFinite(contact.advLat) && (contact.advLat !== 0 || contact.advLon !== 0)) {
      node.advLat = contact.advLat / 1e6;
      node.advLon = contact.advLon / 1e6;
    }
    return { key, node };
  }

  get(key) {
    return this.nodes[key];
  }

  // "Some node name DE CALLSIGN" → callsign, for AIS vessel association
  static callsignOf(node) {
    if (!node || !node.name) {
      return null;
    }
    const matched = node.name.match(DE_PATTERN);
    return matched ? matched[1] : null;
  }

  onlineCount(thresholdSecs, now = new Date()) {
    return Object.values(this.nodes)
      .filter((node) => node.seen
        && node.seen.getTime() > now.getTime() - (thresholdSecs * 1000))
      .length;
  }
}

module.exports = NodeDb;
