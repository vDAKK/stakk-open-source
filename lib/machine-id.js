'use strict';

/**
 * machine-id.js — Remplace node-machine-id qui utilise execSync (flash console Windows)
 */

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');

function getMachineId() {
  if (os.platform() === 'win32') {
    // Utilise spawnSync avec windowsHide pour éviter le flash de console
    const result = spawnSync('reg', [
      'QUERY',
      'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
      '/v',
      'MachineGuid',
    ], { windowsHide: true, encoding: 'utf8' });

    if (result.stdout) {
      const match = result.stdout.match(/MachineGuid\s+REG_SZ\s+([a-f0-9-]+)/i);
      if (match) return match[1];
    }
    return 'unknown-windows';
  }

  if (os.platform() === 'darwin') {
    const result = spawnSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
    const match = result.stdout?.match(/IOPlatformUUID"\s*=\s*"([^"]+)"/);
    // node-machine-id minuscule l'UUID sur darwin avant de le hasher. Le
    // launcher Ankama dérive sa clé keydata avec cette lib : sans le
    // toLowerCase() on hashe une autre chaîne et l'import échoue sur
    // « error:1C800064 bad decrypt ». ioreg renvoie l'UUID en majuscules.
    return match ? match[1].toLowerCase() : 'unknown-mac';
  }

  // Linux
  try {
    return require('fs').readFileSync('/etc/machine-id', 'utf8').trim();
  } catch {
    try {
      return require('fs').readFileSync('/var/lib/dbus/machine-id', 'utf8').trim();
    } catch {
      return 'unknown-linux';
    }
  }
}

function machineIdSync(original = false) {
  const id = getMachineId();
  if (original) return id;
  return crypto.createHash('sha256').update(id).digest('hex');
}

module.exports = { machineIdSync };
